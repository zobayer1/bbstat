import { BitbucketApiError, BitbucketRateLimitError } from './errors.js';

// Minimal logger surface — pino-compatible. Optional; used only for warnings on
// retries and low rate-limit budget. The client never `console.log`s.
export interface BitbucketLogger {
  debug?: (obj: object, msg?: string) => void;
  info?: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface BitbucketClientOptions {
  baseUrl: string;
  email: string;
  token: string;
  logger?: BitbucketLogger;
  retries?: number;
  retryBaseDelayMs?: number;
  rateLimitWarnThreshold?: number;
  // Injectable for tests; defaults to globalThis.fetch (Node 22 native).
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  fields?: string[];
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

// Shape of every BitBucket Cloud paginated endpoint.
export interface PaginatedResponse<T> {
  pagelen: number;
  page?: number;
  size?: number;
  values: T[];
  next?: string;
  previous?: string;
}

const DEFAULTS = {
  retries: 3,
  retryBaseDelayMs: 250,
  rateLimitWarnThreshold: 100,
} as const;

export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger: BitbucketLogger | undefined;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly rateLimitWarnThreshold: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  constructor(opts: BitbucketClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`;
    this.logger = opts.logger;
    this.retries = opts.retries ?? DEFAULTS.retries;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs;
    this.rateLimitWarnThreshold = opts.rateLimitWarnThreshold ?? DEFAULTS.rateLimitWarnThreshold;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Snapshot of the most recent rate-limit headers we observed. */
  getRateLimit(): RateLimitState {
    return { ...this.rateLimit };
  }

  get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  post<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, opts);
  }

  /**
   * Async generator that walks a BitBucket paginated endpoint, yielding each
   * `values[]` item one at a time. Subsequent pages are fetched by following
   * the `next` URL returned by the API; opts are applied only to the first
   * call, since BitBucket's `next` URL preserves the original query string.
   *
   * Field-filtering note: paginated responses wrap items in `values[]`, so
   * filters must use the `values.<field>` prefix. This method auto-appends
   * `next` to the field set if the caller provided one — without it, BitBucket
   * strips the pagination link and iteration silently stops after page 1.
   *
   * @example
   *   for await (const member of client.paginate<Member>(
   *     '/workspaces/foo/members',
   *     { fields: ['values.user.uuid', 'values.user.display_name'] },
   *   )) { ... }
   */
  async *paginate<T = unknown>(initialPath: string, opts: RequestOptions = {}): AsyncGenerator<T, void, void> {
    const fieldsWithNext =
      opts.fields && opts.fields.length > 0 && !opts.fields.includes('next') ? [...opts.fields, 'next'] : opts.fields;

    const firstOpts: RequestOptions = {
      ...opts,
      ...(fieldsWithNext ? { fields: fieldsWithNext } : {}),
      query: { pagelen: 100, ...opts.query },
    };

    let nextUrl: string | null = initialPath;
    let useFirstOpts = true;
    while (nextUrl !== null) {
      const page: PaginatedResponse<T> = useFirstOpts
        ? await this.get<PaginatedResponse<T>>(nextUrl, firstOpts)
        : await this.get<PaginatedResponse<T>>(nextUrl);
      useFirstOpts = false;
      for (const item of page.values) yield item;
      nextUrl = page.next ?? null;
    }
  }

  private async request<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(path, opts);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    };

    let attempt = 0;
    // Loop until success or unrecoverable error. Bounded by `retries`.
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal,
        });
      } catch (err) {
        if (attempt < this.retries) {
          this.logger?.warn?.({ path, attempt, err: String(err) }, 'BitBucket request failed — retrying');
          await this.delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }
        throw err;
      }

      this.updateRateLimit(res.headers);

      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (attempt < this.retries) {
          this.logger?.warn?.({ path, retryAfter, attempt }, 'BitBucket 429 — backing off');
          await this.delay(retryAfter * 1000);
          attempt++;
          continue;
        }
        throw new BitbucketRateLimitError(path, retryAfter);
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt < this.retries) {
          this.logger?.warn?.({ path, status: res.status, attempt }, 'BitBucket 5xx — retrying');
          await this.delay(this.backoffMs(attempt));
          attempt++;
          continue;
        }
        const body = await safeJson(res);
        throw new BitbucketApiError(`BitBucket ${res.status} on ${path}`, res.status, path, body);
      }

      if (!res.ok) {
        // 4xx (other than 429) — don't retry, surface to caller.
        const body = await safeJson(res);
        throw new BitbucketApiError(`BitBucket ${res.status} on ${path}`, res.status, path, body);
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  private buildUrl(path: string, opts: RequestOptions): string {
    // Absolute URLs (e.g., the `next` link returned by paginated endpoints)
    // pass through unchanged — they already carry the original query string.
    const isAbsolute = /^https?:\/\//i.test(path);
    const url = isAbsolute ? new URL(path) : new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (opts.fields && opts.fields.length > 0) {
      url.searchParams.set('fields', opts.fields.join(','));
    }
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private updateRateLimit(headers: Headers): void {
    const limit = parseIntHeader(headers.get('x-ratelimit-limit'));
    const remaining = parseIntHeader(headers.get('x-ratelimit-remaining'));
    const resetSec = parseIntHeader(headers.get('x-ratelimit-reset'));
    this.rateLimit = {
      limit,
      remaining,
      resetAt: resetSec !== null ? new Date(resetSec * 1000) : null,
    };
    if (remaining !== null && remaining < this.rateLimitWarnThreshold) {
      this.logger?.warn?.({ remaining, limit, resetAt: this.rateLimit.resetAt }, 'BitBucket rate-limit budget low');
    }
  }

  private backoffMs(attempt: number): number {
    return this.retryBaseDelayMs * 2 ** attempt;
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function parseIntHeader(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Retry-After can be a delta-seconds integer or an HTTP date.
function parseRetryAfter(v: string | null): number {
  if (!v) return 1;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return 1;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
