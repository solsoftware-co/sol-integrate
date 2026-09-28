import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: ["tests/e2e/**", "node_modules/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // wrangler.toml binds SOL_API to the real sol-api Worker, which
          // doesn't exist inside the test runtime (it refuses to start
          // without it). Unit tests fake sol-api themselves, so this
          // stand-in only answers a call a test forgot to fake — loudly.
          serviceBindings: {
            SOL_API: () =>
              Response.json(
                { success: false, error: { code: "INTERNAL_ERROR", message: "SOL_API not faked in this test" } },
                { status: 503 }
              ),
          },
        },
      },
    },
  },
});
