import { describe, it, expect, vi, beforeEach } from "vitest";

const prepareMock = vi.fn();
const deliverMock = vi.fn();
const logSkippedMock = vi.fn();
vi.mock("../../../src/services/mailchimp-integration.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/mailchimp-integration.js")>(
    "../../../src/services/mailchimp-integration.js"
  );
  return {
    ...actual,
    prepareMailchimpWrite: (...args: unknown[]) => prepareMock(...args),
    deliverMailchimpWrite: (...args: unknown[]) => deliverMock(...args),
    logSkippedWrite: (...args: unknown[]) => logSkippedMock(...args),
  };
});

const { default: app } = await import("../../../src/index.js");
const { IntegrationUnavailableError } = await import("../../../src/services/mailchimp-integration.js");
const { SolApiNotFoundError } = await import("../../../src/lib/sol-api.js");

const ENV = {
  API_KEY: "test-api-key",
  ENVIRONMENT: "development",
  SOL_API_URL: "https://sol-api.test",
  SOL_API_KEY: "sol-key",
  SOL_NOTIFY_URL: "https://sol-notify.test",
  SOL_NOTIFY_API_KEY: "notify-key",
};

const body = {
  clientId: "acme-corp",
  type: "mailchimp",
  integrationId: "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b",
  fields: { email: "jane@example.com" },
};

function post(payload: unknown, headers: Record<string, string> = { "X-API-Key": "test-api-key" }) {
  const waitUntil = vi.fn();
  const ctx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const res = app.request(
    "/",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) },
    ENV,
    ctx
  );
  return { res, waitUntil };
}

beforeEach(() => {
  prepareMock.mockReset();
  deliverMock.mockReset().mockResolvedValue(undefined);
  logSkippedMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /", () => {
  it("401s without the API key", async () => {
    const { res } = post(body, {});
    expect((await res).status).toBe(401);
  });

  it("422s on an invalid envelope", async () => {
    const { res } = post({ ...body, fields: {} });
    const r = await res;
    expect(r.status).toBe(422);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("202s and backgrounds the write for a valid envelope", async () => {
    prepareMock.mockResolvedValue({ clientId: "acme-corp", integrationId: body.integrationId });
    const { res, waitUntil } = post(body);
    const r = await res;

    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ success: true, data: { accepted: true } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith(
      {
        SOL_API_URL: "https://sol-api.test",
        SOL_API_KEY: "sol-key",
        SOL_NOTIFY_URL: "https://sol-notify.test",
        SOL_NOTIFY_API_KEY: "notify-key",
      },
      { clientId: "acme-corp", integrationId: body.integrationId }
    );
  });

  it("404s and logs a skip when the integration doesn't exist", async () => {
    prepareMock.mockRejectedValue(new SolApiNotFoundError("Integration not found"));
    const { res, waitUntil } = post(body);
    const r = await res;

    expect(r.status).toBe(404);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(logSkippedMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(body), "Integration not found");
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("404s when the integration is unusable (wrong type / inactive)", async () => {
    prepareMock.mockRejectedValue(new IntegrationUnavailableError("Integration is not active"));
    const { res } = post(body);
    expect((await res).status).toBe(404);
  });

  it("500s on an unexpected sol-api failure", async () => {
    prepareMock.mockRejectedValue(new Error("sol-api exploded"));
    const { res } = post(body);
    expect((await res).status).toBe(500);
  });
});
