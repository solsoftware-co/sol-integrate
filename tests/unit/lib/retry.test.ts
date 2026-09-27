import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../../../src/lib/retry.js";

describe("withRetry", () => {
  it("retries up to the attempt limit, then throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("returns as soon as an attempt succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValue("ok");
    await expect(withRetry(fn, { baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(withRetry(fn, { baseDelayMs: 0, shouldRetry: () => false })).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
