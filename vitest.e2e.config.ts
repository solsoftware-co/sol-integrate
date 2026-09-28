import { defineConfig } from "vitest/config";

// Runs in plain Node against a deployed preview Worker (PREVIEW_URL), not
// inside the Workers pool like the unit suite — see .github/workflows/pr.yml.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
