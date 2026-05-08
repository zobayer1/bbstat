export class BitbucketApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'BitbucketApiError';
  }
}

export class BitbucketRateLimitError extends BitbucketApiError {
  constructor(
    path: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(`Rate limited by BitBucket on ${path}; retry after ${retryAfterSeconds}s`, 429, path);
    this.name = 'BitbucketRateLimitError';
  }
}
