import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withLogScope, idFromHeader } from "../../../src/lib/log-context.js";
import { logger } from "../../../src/lib/logger.js";
import { getIntegration } from "../../../src/lib/sol-api.js";

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log");
});
afterEach(() => vi.restoreAllMocks());

const loggedLines = () => logSpy.mock.calls.map(([line]) => JSON.parse(line as string));

describe("log scope", () => {
  it("adds environment, traceId and submissionId to every log line inside the scope", async () => {
    await withLogScope({ environment: "staging", traceId: "trace-1", submissionId: "sub-1" }, async () => {
      await Promise.resolve();
      logger.info("inside", { integrationId: "i-1" });
    });
    logger.info("outside");

    const [inside, outside] = loggedLines();
    expect(inside).toMatchObject({ environment: "staging", traceId: "trace-1", submissionId: "sub-1", integrationId: "i-1" });
    expect(outside).not.toHaveProperty("traceId");
    expect(outside).not.toHaveProperty("submissionId");
  });
});

describe("idFromHeader", () => {
  it("uses the caller's id, and nothing without a usable one", () => {
    expect(idFromHeader("sub-1")).toBe("sub-1");
    expect(idFromHeader(undefined)).toBeUndefined();
    expect(idFromHeader("   ")).toBeUndefined();
    expect(idFromHeader("x".repeat(129))).toBeUndefined();
  });
});

describe("sol-api client", () => {
  it("forwards the scope's trace and submission ids to sol-api, and neither outside a scope", async () => {
    const sent: Headers[] = [];
    const solApi = {
      fetch: async (_url: string, init: RequestInit) => {
        sent.push(new Headers(init.headers));
        return Response.json({ success: true, data: {} });
      },
    } as unknown as Fetcher;

    await withLogScope({ traceId: "trace-1", submissionId: "sub-1" }, () => getIntegration(solApi, "k", "acme", "i-1"));
    await getIntegration(solApi, "k", "acme", "i-1");

    expect(sent[0].get("X-Trace-Id")).toBe("trace-1");
    expect(sent[0].get("X-Submission-Id")).toBe("sub-1");
    expect(sent[1].has("X-Trace-Id")).toBe(false);
    expect(sent[1].has("X-Submission-Id")).toBe(false);
  });
});
