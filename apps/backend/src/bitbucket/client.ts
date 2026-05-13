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
  // Soft cap on outbound calls per rolling hour. We count ourselves because
  // BB Cloud omits X-RateLimit-* headers on success — see
  // memory/bitbucket_rate_limit_headers.md. Default 800 leaves a 200-call
  // buffer below BB's documented ~1000/hr per-identity limit.
  hourlyCallBudget?: number;
  // Minimum wall-clock interval between successive outbound calls from this
  // client. BB Cloud's documented 1000/hr limit hides a finer-grained burst
  // limiter that 429s well below the hourly count when calls go out faster
  // than a few per second. Pacing here keeps us under that threshold without
  // any client knowledge of what the threshold actually is. 0 = disabled
  // (default in tests; production wires ~400ms via env). Applies to every
  // attempt including retries — but retry-after / backoff sleeps naturally
  // satisfy this gate, so no compounding penalty in the 429/5xx path.
  minCallIntervalMs?: number;
  // Hard ceiling on the adaptive pacing. Every observed 429 doubles the
  // *current* pacing interval (min → 2× → 4× → ... → max). When the next
  // retry would push past `maxCallIntervalMs`, the client stays at the cap
  // and lets the retry budget exhaust normally — which surfaces as a
  // `BitbucketRateLimitError` for the tick orchestrator to abort on.
  // 0 disables adaptive bumping entirely (falls back to flat
  // `minCallIntervalMs` pacing).
  maxCallIntervalMs?: number;
  // After this many consecutive non-429 responses, halve `currentPacingMs`
  // back toward `minCallIntervalMs` (floor at the min). Lets the client
  // recover automatically once BB's burst window has rotated. Default 20.
  pacingDecaySuccesses?: number;
  // Injectable for tests; defaults to globalThis.fetch (Node 22 native).
  fetch?: typeof globalThis.fetch;
  // Injectable for tests of the call-ledger sliding window.
  now?: () => number;
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
  hourlyCallBudget: 800,
  minCallIntervalMs: 0,
  maxCallIntervalMs: 0,
  pacingDecaySuccesses: 20,
} as const;

const HOUR_MS = 3_600_000;

export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly logger: BitbucketLogger | undefined;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly rateLimitWarnThreshold: number;
  private readonly hourlyCallBudget: number;
  private readonly minCallIntervalMs: number;
  private readonly maxCallIntervalMs: number;
  private readonly pacingDecaySuccesses: number;
  // Adaptive pacing state. `currentPacingMs` starts at `minCallIntervalMs`
  // and doubles on every observed 429 (capped at `maxCallIntervalMs`).
  // After `pacingDecaySuccesses` consecutive non-429 responses it halves
  // back toward the floor. Sticky across ticks — the client instance lives
  // for the process lifetime, so a 429 storm at minute 5 keeps us paced
  // conservatively at minute 6 without re-discovering BB's burst limit.
  private currentPacingMs: number;
  private consecutiveNon429 = 0;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };
  // Sliding-window ledger of outbound-fetch timestamps. Includes retries —
  // each network attempt costs one against the BB-side counter, even if it
  // 429'd or 5xx'd, so it must cost one against ours too.
  private callTimestamps: number[] = [];
  // Wall-clock timestamp of the most recent fetch attempt (any outcome).
  // Used by the inter-call pacer to throttle bursts under BB's hidden
  // sub-second limiter. 0 = no prior call.
  private lastCallAt = 0;

  constructor(opts: BitbucketClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`;
    this.logger = opts.logger;
    this.retries = opts.retries ?? DEFAULTS.retries;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs;
    this.rateLimitWarnThreshold = opts.rateLimitWarnThreshold ?? DEFAULTS.rateLimitWarnThreshold;
    this.hourlyCallBudget = opts.hourlyCallBudget ?? DEFAULTS.hourlyCallBudget;
    this.minCallIntervalMs = opts.minCallIntervalMs ?? DEFAULTS.minCallIntervalMs;
    this.maxCallIntervalMs = opts.maxCallIntervalMs ?? DEFAULTS.maxCallIntervalMs;
    this.pacingDecaySuccesses = opts.pacingDecaySuccesses ?? DEFAULTS.pacingDecaySuccesses;
    this.currentPacingMs = this.minCallIntervalMs;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  /** Snapshot of the most recent rate-limit headers we observed. */
  getRateLimit(): RateLimitState {
    return { ...this.rateLimit };
  }

  /** Current adaptive pacing in ms. Bumps on 429s, decays on clean streaks. */
  getCurrentPacingMs(): number {
    return this.currentPacingMs;
  }

  /** Outbound-fetch attempts made in the last rolling hour. */
  getCallsInLastHour(): number {
    const cutoff = this.now() - HOUR_MS;
    // Opportunistic trim — the ledger never grows beyond ~budget entries
    // because callers stop scheduling when remaining hits zero.
    if (this.callTimestamps.length > 0 && this.callTimestamps[0]! < cutoff) {
      this.callTimestamps = this.callTimestamps.filter((t) => t >= cutoff);
    }
    return this.callTimestamps.length;
  }

  /**
   * Headroom under `hourlyCallBudget` in the current rolling hour. Tick
   * orchestrators consult this before scheduling the next repo so a single
   * cron run can't exhaust the per-identity rate limit.
   */
  getBudgetRemaining(): number {
    return Math.max(0, this.hourlyCallBudget - this.getCallsInLastHour());
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
      // Pace successive calls. Retry-after / backoff sleeps in the catch
      // branches below have already advanced wall-clock, so this gate is a
      // no-op on retries — only the initial attempt and back-to-back happy-
      // path calls actually wait here. `currentPacingMs` is adaptive: it
      // doubles on each 429 (up to `maxCallIntervalMs`) and decays back
      // toward the floor on streaks of clean responses.
      if (this.currentPacingMs > 0 && this.lastCallAt > 0) {
        const elapsed = this.now() - this.lastCallAt;
        if (elapsed < this.currentPacingMs) {
          await this.delay(this.currentPacingMs - elapsed);
        }
      }
      this.lastCallAt = this.now();
      this.callTimestamps.push(this.now());
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
        this.consecutiveNon429 = 0;
        // Bump adaptive pacing — sticky for subsequent calls. Capped at
        // `maxCallIntervalMs`; once capped, additional 429s leave it at the
        // ceiling and the retry budget exhausts as usual.
        if (this.maxCallIntervalMs > 0 && this.currentPacingMs < this.maxCallIntervalMs) {
          const next = Math.min(
            Math.max(this.currentPacingMs * 2, this.minCallIntervalMs || this.maxCallIntervalMs),
            this.maxCallIntervalMs,
          );
          if (next !== this.currentPacingMs) {
            this.logger?.warn?.(
              { path, previousPacingMs: this.currentPacingMs, newPacingMs: next, attempt },
              'BitBucket 429 — increasing call pacing',
            );
            this.currentPacingMs = next;
          }
        }
        if (attempt < this.retries) {
          this.logger?.warn?.({ path, retryAfter, attempt }, 'BitBucket 429 — backing off');
          await this.delay(retryAfter * 1000);
          attempt++;
          continue;
        }
        throw new BitbucketRateLimitError(path, retryAfter);
      }

      // Non-429 from here on — count toward decay. We decay on any
      // non-429 outcome (including handled 5xx that won't retry, and
      // non-2xx 4xx) since the burst limiter only cares about 429s.
      this.consecutiveNon429++;
      if (
        this.maxCallIntervalMs > 0 &&
        this.currentPacingMs > this.minCallIntervalMs &&
        this.consecutiveNon429 >= this.pacingDecaySuccesses
      ) {
        const next = Math.max(Math.floor(this.currentPacingMs / 2), this.minCallIntervalMs);
        this.logger?.info?.(
          { previousPacingMs: this.currentPacingMs, newPacingMs: next, after: this.consecutiveNon429 },
          'BitBucket pacing decay — relaxing after clean streak',
        );
        this.currentPacingMs = next;
        this.consecutiveNon429 = 0;
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
