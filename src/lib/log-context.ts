import { AsyncLocalStorage } from "node:async_hooks";

// Fields every log line carries without each call passing them (SOL-46):
// - environment: the Worker's ENVIRONMENT, so Workers Observability can
//   filter by it.
// - traceId: one run of work, followed across sol-gate, sol-integrate,
//   sol-notify and sol-api. Every log line has one.
// - submissionId: the form submission the work is for, assigned by Sol Gate.
//   Only on lines that are for a submission. A replayed submission would keep
//   its submissionId under a new traceId.
// Both ids travel between services as TRACE_ID_HEADER / SUBMISSION_ID_HEADER.
//
// A request uses its caller's traceId, or starts a new one; it uses the
// caller's submissionId, but never makes one up. Set per request (index.ts);
// AsyncLocalStorage carries them through every await and waitUntil below
// that, and lib/sol-api.ts forwards them.
export interface LogScope {
  environment?: string;
  traceId?: string;
  submissionId?: string;
}

export const TRACE_ID_HEADER = "X-Trace-Id";
export const SUBMISSION_ID_HEADER = "X-Submission-Id";

const storage = new AsyncLocalStorage<LogScope>();

/** Runs `fn` with `scope` added to the current one. */
export function withLogScope<T>(scope: LogScope, fn: () => T): T {
  return storage.run({ ...currentLogScope(), ...scope }, fn);
}

export function currentLogScope(): LogScope {
  return storage.getStore() ?? {};
}

/** The current trace and submission ids, as headers for a call to another internal service. */
export function traceHeaders(): Record<string, string> {
  const { traceId, submissionId } = currentLogScope();
  return {
    ...(traceId && { [TRACE_ID_HEADER]: traceId }),
    ...(submissionId && { [SUBMISSION_ID_HEADER]: submissionId }),
  };
}

// Generous for a UUID, small enough that an odd header can't bloat every line.
const MAX_ID_LENGTH = 128;

/** An id from a caller's header, if it sent a usable one. */
export function idFromHeader(header: string | undefined): string | undefined {
  const id = header?.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : undefined;
}
