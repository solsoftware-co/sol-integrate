import { Hono } from "hono";
import { errorHandler } from "./middleware/error.js";
import { requireApiKey } from "./middleware/auth.js";
import health from "./routes/health.js";
import integration from "./routes/integration.js";
import type { AppEnv } from "./types/index.js";

const app = new Hono<AppEnv>();

app.onError(errorHandler);
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
});

app.route("/health", health);
app.use("/*", requireApiKey);
app.route("/", integration);

export default app;
