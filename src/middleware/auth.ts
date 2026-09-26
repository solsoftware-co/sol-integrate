import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../types/index.js";
import { logger } from "../lib/logger.js";

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const key = c.req.header("X-API-Key");
  if (!key || key !== c.env.API_KEY) {
    logger.warn("rejected request: invalid or missing API key", {
      requestId: c.get("requestId"),
      path: c.req.path,
      method: c.req.method,
      credentialPresent: Boolean(key),
    });
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
});
