import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ErrorCode, type AppEnv } from "../types/index.js";
import { logger } from "../lib/logger.js";

export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof HTTPException) {
    const code = statusToErrorCode(err.status);
    return c.json(
      { success: false, error: { code, message: err.message, details: null } },
      err.status as Parameters<typeof c.json>[1]
    );
  }

  logger.error("unhandled error", {
    requestId: c.get("requestId"),
    path: c.req.path,
    method: c.req.method,
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack,
  });
  return c.json(
    { success: false, error: { code: ErrorCode.INTERNAL_ERROR, message: "An unexpected error occurred", details: null } },
    500
  );
}

function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
