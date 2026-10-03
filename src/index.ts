import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import { requireApiKey } from "./middleware/auth.js";
import health from "./routes/health.js";
import integration from "./routes/integration.js";
import { parseEnvironment } from "./lib/environment.js";
import { SUBMISSION_ID_HEADER, TRACE_ID_HEADER, idFromHeader, withLogScope } from "./lib/log-context.js";
import type { AppEnv } from "./types/index.js";

const app = new Hono<AppEnv>();

app.onError(errorHandler);
app.use("*", async (c, next) => {
  // The caller's trace (Sol Gate's, forwarded), or a new one; and Sol Gate's
  // submissionId when the request is for a submission — never made up here.
  // Both go on every log line of the request and are forwarded to sol-api
  // (SOL-46).
  const traceId = idFromHeader(c.req.header(TRACE_ID_HEADER)) ?? crypto.randomUUID();
  const submissionId = idFromHeader(c.req.header(SUBMISSION_ID_HEADER));

  await withLogScope({ environment: c.env.ENVIRONMENT, traceId, submissionId }, async () => {
    // Fail fast on a misconfigured ENVIRONMENT, on every route (including
    // /health) — it decides whether Mailchimp writes are real or mocked, so a
    // typo must never fall through to either by default.
    parseEnvironment(c.env.ENVIRONMENT);
    await next();
  });
});

app.route("/health", health);
app.use("/*", requireApiKey);
app.route("/", integration);

export default app;
