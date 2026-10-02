import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const logMock = vi.fn();
vi.mock("../../../src/services/mailchimp-integration.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/mailchimp-integration.js")>(
    "../../../src/services/mailchimp-integration.js"
  );
  return {
    ...actual,
    runMailchimpWrite: (...args: unknown[]) => runMock(...args),
    logWriteOutcome: (...args: unknown[]) => logMock(...args),
  };
});

const { default: app } = await import("../../../src/index.js");

const SOL_API = {} as Fetcher;
const ENV = { API_KEY: "test-api-key", ENVIRONMENT: "staging", SOL_API, SOL_API_KEY: "sol-key" };

const body = {
  clientId: "acme-corp",
  type: "mailchimp",
  integrationId: "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b",
  fields: { email: "jane@example.com" },
};

async function post(payload: unknown, opts: { headers?: Record<string, string>; env?: Record<string, unknown> } = {}) {
  const waitUntil = vi.fn();
  const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const res = await app.request(
    "/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? { "X-API-Key": "test-api-key" }) },
      body: JSON.stringify(payload),
    },
    { ...ENV, ...opts.env },
    ctx
  );
  return { res, waitUntil };
}

beforeEach(() => {
  runMock.mockReset();
  logMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /", () => {
  it("401s without the API key", async () => {
    const { res } = await post(body, { headers: {} });
    expect(res.status).toBe(401);
  });

  it("500s every request on an invalid ENVIRONMENT", async () => {
    const { res } = await post(body, { env: { ENVIRONMENT: "prod" } });
    expect(res.status).toBe(500);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("422s on a malformed request", async () => {
    const { res } = await post({ ...body, fields: {} });
    expect(res.status).toBe(422);
    expect(runMock).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "succeeded", url: "https://us21.admin.mailchimp.com/lists/members/view?id=1", memberId: "member-1" },
    { outcome: "failed", url: "https://us21.admin.mailchimp.com/lists/", detail: "Invalid Resource" },
    { outcome: "skipped", detail: "Integration not found" },
  ])("returns 200 with the $outcome result", async (result) => {
    runMock.mockResolvedValue({ result });

    const { res } = await post(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: result });
  });

  it.each([
    ["failed", "warn", { outcome: "failed", detail: "Invalid Resource" }],
    ["succeeded", "info", { outcome: "succeeded", memberId: "member-1" }],
    ["skipped", "info", { outcome: "skipped", detail: "Integration not found" }],
  ])("logs a %s write at %s", async (_outcome, level, result) => {
    runMock.mockResolvedValue({ result });
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    await post(body);

    const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls].map(([line]) => JSON.parse(line));
    const finished = lines.find((e) => e.message === "integration write finished");
    expect(finished).toMatchObject({ level, outcome: result.outcome });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never returns the internal error message to the caller", async () => {
    runMock.mockResolvedValue({
      result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
      errorMessage: "sol-api returned non-JSON (HTTP 530): error code: 1042",
    });

    const { res } = await post(body);

    expect(JSON.stringify(await res.json())).not.toContain("1042");
  });

  it("passes the binding and parsed environment to the service, and logs in the background", async () => {
    const run = { result: { outcome: "succeeded", memberId: "member-1" } };
    runMock.mockResolvedValue(run);

    const { waitUntil } = await post(body);

    expect(runMock).toHaveBeenCalledWith(
      { SOL_API, SOL_API_KEY: "sol-key", ENVIRONMENT: "staging" },
      expect.objectContaining(body)
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith({ SOL_API, SOL_API_KEY: "sol-key" }, expect.objectContaining(body), run);
  });

  it("500s on an unexpected error", async () => {
    runMock.mockRejectedValue(new Error("boom"));
    const { res } = await post(body);
    expect(res.status).toBe(500);
  });
});
