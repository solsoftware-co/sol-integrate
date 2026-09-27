// Used both in the request path (the Mailchimp write — its outcome is the
// response) and inside ctx.waitUntil() (the audit-log write). Blocking in
// the request path is fine here: the only caller is Sol Gate, which runs
// this call inside its own backgrounded work after answering the browser —
// but keep attempts and timeouts tight, since that work shares Sol Gate's
// ~30s waitUntil budget.

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
