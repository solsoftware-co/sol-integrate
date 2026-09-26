import type { Context } from "hono";
import { ErrorCode, type AppEnv } from "../types/index.js";

export function notFoundResponse(c: Context<AppEnv>, message: string) {
  return c.json(
    { success: false as const, error: { code: ErrorCode.NOT_FOUND, message, details: null } },
    404
  );
}

export function validationErrorResponse(c: Context<AppEnv>, message: string, details: unknown = null) {
  return c.json(
    { success: false as const, error: { code: ErrorCode.VALIDATION_ERROR, message, details } },
    422
  );
}
