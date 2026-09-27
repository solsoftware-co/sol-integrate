export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  [key: string]: unknown;
}

// Belt-and-suspenders: even if a caller accidentally passes a secret-shaped
// value, strip it before it reaches console output. Callers should still
// only pass safe, scoped fields.
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|authorization/i;

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = redactValue(k, v);
  }
  return result;
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...redactObject(context),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => write("debug", message, context),
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
};
