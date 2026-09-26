import { Hono } from "hono";
import type { AppEnv } from "../types/index.js";

const health = new Hono<AppEnv>();

health.get("/", (c) => {
  return c.json({
    success: true,
    data: { status: "ok", environment: c.env.ENVIRONMENT, version: c.env.APP_VERSION ?? "unknown" },
  });
});

export default health;
