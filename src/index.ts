import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import { requireApiKey } from "./middleware/auth.js";
import health from "./routes/health.js";
import integration from "./routes/integration.js";
import { parseEnvironment } from "./lib/environment.js";
import type { AppEnv } from "./types/index.js";

const app = new Hono<AppEnv>();

app.onError(errorHandler);
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  // Fail fast on a misconfigured ENVIRONMENT, on every route (including
  // /health) — it decides whether Mailchimp writes are real or mocked, so a
  // typo must never fall through to either by default.
  parseEnvironment(c.env.ENVIRONMENT);
  await next();
});

app.route("/health", health);
app.use("/*", requireApiKey);
app.route("/", integration);

export default app;
