// Only ever called from inside ctx.waitUntil() (the backgrounded half of a
// request), never the synchronous request path — retry backoff would block
// a caller (including client sites calling this service directly over HTTP
// on form submit) for no reason otherwise.

export interface RetryOptions {
  attempts?: number;
  /** Base delay in ms; actual delay is baseDelayMs * 2^attemptIndex. */
  baseDelayMs?: number;
  /** Return false to fail immediately without further attempts (e.g. a permanent 4xx). Defaults to always retrying. */
  shouldRetry?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err)) break;
      if (attempt < attempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}
