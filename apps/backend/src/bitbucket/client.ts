import { BitbucketApiError, BitbucketRateLimitError } from './errors.js';

// Minimal pino-compatible logger surface. Optional.
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
  // buffer below BB's ~1000/hr per-identity limit.
  hourlyCallBudget?: number;
  // Minimum wall-clock interval between successive outbound calls. BB's
  // documented 1000/hr limit hides a finer-grained burst limiter that 429s
  // well below the hourly count above a few calls/sec; pacing keeps us under
  // it. 0 = disabled (tests; prod wires ~400ms). Applies to retries too, but
  // retry-after / backoff sleeps already satisfy the gate, so no compounding.
  minCallIntervalMs?: number;
  // Hard ceiling on adaptive pacing. Every 429 doubles the current interval
  // (min → 2× → ... → max). At the cap the retry budget exhausts normally,
  // surfacing as `BitbucketRateLimitError` for the tick orchestrator. 0
  // disables adaptive bumping (flat `minCallIntervalMs` pacing).
  maxCallIntervalMs?: number;
  // After this many consecutive non-429 responses, halve `currentPacingMs`
  // back toward `minCallIntervalMs` (floored). Recovers once BB's burst
  // window has rotated. Default 20.
  pacingDecaySuccesses?: number;
  // Injectable for tests; defaults to globalThis.fetch.
  fetch?: typeof globalThis.fetch;
  // Injectable for tests of the call-ledger sliding window.
  now?: () => number;
  // Fires only on edge transitions. 401/403 → 'unauthorized', any 2xx → 'ok';
  // 429 / 5xx / network errors do NOT change auth state (availability, not
  // credentials). First 2xx after boot is a no-op UNLESS `initialAuthState`
  // was 'unauthorized', which is a genuine transition that must reach the UI.
  // Hook owners write Redis + publish the SSE event so the dashboard `!!`
  // flips red on token expiry.
  onAuthStateChange?: (state: BitbucketAuthState) => void;
  // Hydrated from the Redis flag at startup; defaults to 'ok'. When a previous
  // process crashed/restarted while the flag was 'unauthorized' (token rotated
  // out-of-band), passing 'unauthorized' lets the first 2xx clear Redis and
  // publish 'ok'. Without it the dashboard stays red forever — the in-memory
  // dedupe never sees an edge against the stale Redis flag.
  initialAuthState?: BitbucketAuthState;
}

export type BitbucketAuthState = 'ok' | 'unauthorized';

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
  // Adaptive pacing state. Doubles on every 429 (capped at maxCallIntervalMs),
  // halves after pacingDecaySuccesses clean responses. Sticky across ticks —
  // the instance lives for the process lifetime, so a 429 storm keeps us paced
  // conservatively without re-discovering BB's burst limit each tick.
  private currentPacingMs: number;
  private consecutiveNon429 = 0;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly onAuthStateChange: ((state: BitbucketAuthState) => void) | undefined;
  // Last auth state surfaced to the hook. See `initialAuthState`.
  private lastAuthState: BitbucketAuthState;
  private rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };
  // Sliding-window ledger of outbound-fetch timestamps. Includes retries —
  // each attempt costs one against BB's counter even if it 429'd / 5xx'd, so
  // it must cost one against ours too.
  private callTimestamps: number[] = [];
  // Wall-clock of the most recent fetch attempt, for the inter-call pacer.
  // 0 = no prior call.
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
    this.onAuthStateChange = opts.onAuthStateChange;
    this.lastAuthState = opts.initialAuthState ?? 'ok';
  }

  private notifyAuthState(state: BitbucketAuthState): void {
    if (this.lastAuthState === state) return;
    this.lastAuthState = state;
    try {
      this.onAuthStateChange?.(state);
    } catch (err) {
      // Hook misbehavior must never break the request path.
      this.logger?.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'bitbucket: onAuthStateChange threw',
      );
    }
  }

  /** Snapshot of the most recent rate-limit headers we observed. */
  getRateLimit(): RateLimitState {
    return { ...this.rateLimit };
  }

  /** Current adaptive pacing in ms. Bumps on 429s, decays on clean streaks. */
  getCurrentPacingMs(): number {
    return this.currentPacingMs;
  }

  /**
   * True when the pacer has ramped to its ceiling (`maxCallIntervalMs`),
   * reached only after a series of 429s — so BB is signaling sustained
   * back-pressure and each call is likely to 429 again. Hot ingest loops
   * (the per-commit diff-stat walker) use this as a pre-emptive yield signal:
   * defer remaining work to the next cron firing, by which time the rolling
   * window has rotated and the pacer has decayed.
   */
  isPacingSaturated(): boolean {
    return this.maxCallIntervalMs > 0 && this.currentPacingMs >= this.maxCallIntervalMs;
  }

  /** Outbound-fetch attempts made in the last rolling hour. */
  getCallsInLastHour(): number {
    const cutoff = this.now() - HOUR_MS;
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
   * Walks a BitBucket paginated endpoint, yielding each `values[]` item. Pages
   * follow the API's `next` URL; opts apply only to the first call since `next`
   * preserves the original query string.
   *
   * Auto-appends `next` to the caller's field set — without it BitBucket strips
   * the pagination link and iteration silently stops after page 1.
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
    for (;;) {
      let res: Response;
      // Pace successive calls. Retry-after / backoff sleeps in the catch
      // branches have already advanced wall-clock, so this gate is a no-op on
      // retries — only the initial attempt and back-to-back happy-path calls
      // wait here.
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
        // Bump adaptive pacing, capped at `maxCallIntervalMs`; once capped,
        // further 429s leave it at the ceiling and the retry budget exhausts.
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

      // Non-429 from here on — count toward decay (5xx and other 4xx
      // included; the burst limiter only cares about 429s).
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
        if (res.status === 401 || res.status === 403) {
          this.notifyAuthState('unauthorized');
        }
        const body = await safeJson(res);
        throw new BitbucketApiError(`BitBucket ${res.status} on ${path}`, res.status, path, body);
      }

      // Any 2xx clears a prior auth-failure state (transition-only hook).
      this.notifyAuthState('ok');
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
