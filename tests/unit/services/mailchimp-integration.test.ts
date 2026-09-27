import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MailchimpEnvelope } from "../../../src/validators/integration.js";

const getIntegrationMock = vi.fn();
const writeNotificationLogMock = vi.fn();
vi.mock("../../../src/lib/sol-api.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/sol-api.js")>("../../../src/lib/sol-api.js");
  return {
    ...actual,
    getIntegration: (...args: unknown[]) => getIntegrationMock(...args),
    writeNotificationLog: (...args: unknown[]) => writeNotificationLogMock(...args),
  };
});

const upsertListMemberMock = vi.fn();
const mockUpsertListMemberMock = vi.fn();
vi.mock("../../../src/lib/mailchimp.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/mailchimp.js")>("../../../src/lib/mailchimp.js");
  return {
    ...actual,
    upsertListMember: (...args: unknown[]) => upsertListMemberMock(...args),
    mockUpsertListMember: (...args: unknown[]) => mockUpsertListMemberMock(...args),
  };
});

const { runMailchimpWrite, logWriteOutcome } = await import("../../../src/services/mailchimp-integration.js");
const { SolApiNotFoundError } = await import("../../../src/lib/sol-api.js");
const { MailchimpApiError } = await import("../../../src/lib/mailchimp.js");

const SOL_API = {} as Fetcher;
const SOL_API_ENV = { SOL_API, SOL_API_KEY: "test-key" };
const ENV = { ...SOL_API_ENV, ENVIRONMENT: "staging" as const };
const INTEGRATION_ID = "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b";
const MAILCHIMP_CONFIG = { apiKey: "abc123-us21", listId: "list42", serverPrefix: "us21" };

const envelope: MailchimpEnvelope = {
  clientId: "acme-corp",
  type: "mailchimp",
  integrationId: INTEGRATION_ID,
  fields: { email: "jane@example.com", mergeFields: { FNAME: "Jane" } },
};

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION_ID,
    clientId: "acme-corp",
    type: "mailchimp",
    name: "Newsletter",
    description: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    mailchimp: MAILCHIMP_CONFIG,
    ...overrides,
  };
}

beforeEach(() => {
  getIntegrationMock.mockReset().mockResolvedValue(integration());
  writeNotificationLogMock.mockReset().mockResolvedValue(undefined);
  upsertListMemberMock.mockReset();
  mockUpsertListMemberMock.mockReset();
});

describe("runMailchimpWrite", () => {
  it("looks up the integration through the binding, scoped to the client", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1", webId: 123456 });
    await runMailchimpWrite(ENV, envelope);
    expect(getIntegrationMock).toHaveBeenCalledWith(SOL_API, "test-key", "acme-corp", INTEGRATION_ID);
  });

  it("returns succeeded with a link to the member", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1", webId: 123456 });

    const run = await runMailchimpWrite(ENV, envelope);

    expect(upsertListMemberMock).toHaveBeenCalledWith(MAILCHIMP_CONFIG, envelope.fields);
    expect(run).toEqual({
      result: {
        outcome: "succeeded",
        url: "https://us21.admin.mailchimp.com/lists/members/view?id=123456",
        memberId: "member-1",
      },
    });
  });

  it("mocks the write in development — Mailchimp is never called", async () => {
    mockUpsertListMemberMock.mockResolvedValue({ memberId: "hash", webId: 0 });

    const run = await runMailchimpWrite({ ...ENV, ENVIRONMENT: "development" }, envelope);

    expect(upsertListMemberMock).not.toHaveBeenCalled();
    expect(mockUpsertListMemberMock).toHaveBeenCalledTimes(1);
    // No real web_id, so it falls back to the audiences page.
    expect(run.result).toEqual({
      outcome: "succeeded",
      url: "https://us21.admin.mailchimp.com/lists/",
      memberId: "hash",
    });
  });

  it.each(["preview", "production"] as const)("writes for real in %s", async (environment) => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1", webId: 1 });
    await runMailchimpWrite({ ...ENV, ENVIRONMENT: environment }, envelope);
    expect(upsertListMemberMock).toHaveBeenCalledTimes(1);
    expect(mockUpsertListMemberMock).not.toHaveBeenCalled();
  });

  it("returns failed with Mailchimp's readable reason on a permanent error, without retrying", async () => {
    upsertListMemberMock.mockRejectedValue(new MailchimpApiError(400, "Member In Compliance State: unsubscribed"));

    const run = await runMailchimpWrite(ENV, envelope);

    expect(upsertListMemberMock).toHaveBeenCalledTimes(1);
    expect(run).toEqual({
      result: {
        outcome: "failed",
        url: "https://us21.admin.mailchimp.com/lists/",
        detail: "Member In Compliance State: unsubscribed",
      },
      errorMessage: "Mailchimp 400: Member In Compliance State: unsubscribed",
    });
  });

  it("retries a transient error once, then succeeds", async () => {
    upsertListMemberMock
      .mockRejectedValueOnce(new MailchimpApiError(503, "Service Unavailable"))
      .mockResolvedValue({ memberId: "member-1", webId: 1 });

    const run = await runMailchimpWrite(ENV, envelope);

    expect(upsertListMemberMock).toHaveBeenCalledTimes(2);
    expect(run.result.outcome).toBe("succeeded");
  });

  it("gives up after 2 attempts on repeated transient errors", async () => {
    upsertListMemberMock.mockRejectedValue(new MailchimpApiError(503, "Service Unavailable"));

    const run = await runMailchimpWrite(ENV, envelope);

    expect(upsertListMemberMock).toHaveBeenCalledTimes(2);
    expect(run.result).toMatchObject({ outcome: "failed", detail: "Service Unavailable" });
  });

  it.each([
    ["not found", () => getIntegrationMock.mockRejectedValue(new SolApiNotFoundError("Integration not found: x")), "Integration not found"],
    ["the wrong type", () => getIntegrationMock.mockResolvedValue(integration({ type: "google_sheets", mailchimp: undefined })), "Integration is a google_sheets integration, not Mailchimp"],
    ["not active", () => getIntegrationMock.mockResolvedValue(integration({ status: "disabled" })), "Integration is not active (status: disabled)"],
    ["missing its Mailchimp config", () => getIntegrationMock.mockResolvedValue(integration({ mailchimp: null })), "Integration has no Mailchimp settings configured"],
  ])("returns skipped when the integration is %s", async (_case, arrange, detail) => {
    arrange();

    const run = await runMailchimpWrite(ENV, envelope);

    expect(run).toEqual({ result: { outcome: "skipped", detail } });
    expect(upsertListMemberMock).not.toHaveBeenCalled();
  });

  it("returns failed, not a thrown error, when sol-api can't be reached", async () => {
    getIntegrationMock.mockRejectedValue(new Error("sol-api returned non-JSON (HTTP 530): error code: 1042"));

    const run = await runMailchimpWrite(ENV, envelope);

    expect(run).toEqual({
      result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
      errorMessage: "sol-api returned non-JSON (HTTP 530): error code: 1042",
    });
  });

  it("never puts credentials in the result", async () => {
    upsertListMemberMock.mockRejectedValue(new MailchimpApiError(401, "API Key Invalid: Your API key may be invalid"));
    const run = await runMailchimpWrite(ENV, envelope);
    expect(JSON.stringify(run)).not.toContain(MAILCHIMP_CONFIG.apiKey);
  });
});

describe("logWriteOutcome", () => {
  it("logs the outcome with trace context and the internal error", async () => {
    await logWriteOutcome(
      SOL_API_ENV,
      { ...envelope, context: { formId: "0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b", submissionId: "sub_123" } },
      {
        result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
        errorMessage: "sol-api returned non-JSON (HTTP 530): error code: 1042",
      }
    );

    expect(writeNotificationLogMock).toHaveBeenCalledWith(SOL_API, "test-key", {
      clientId: "acme-corp",
      workflow: "integration-service",
      eventName: "mailchimp.upsert_member",
      outcome: "failed",
      type: "mailchimp",
      errorMessage: "sol-api returned non-JSON (HTTP 530): error code: 1042",
      metadata: {
        integrationId: INTEGRATION_ID,
        email: "jane@example.com",
        tags: [],
        formId: "0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
        submissionId: "sub_123",
      },
    });
  });

  it("logs a skip's detail as its error message, and a success's memberId", async () => {
    await logWriteOutcome(SOL_API_ENV, envelope, { result: { outcome: "skipped", detail: "Integration not found" } });
    await logWriteOutcome(SOL_API_ENV, envelope, { result: { outcome: "succeeded", memberId: "member-1" } });

    expect(writeNotificationLogMock.mock.calls[0][2]).toMatchObject({ outcome: "skipped", errorMessage: "Integration not found" });
    expect(writeNotificationLogMock.mock.calls[1][2]).toMatchObject({
      outcome: "succeeded",
      errorMessage: null,
      metadata: { memberId: "member-1" },
    });
  });

  it("does not throw when the log write itself fails", async () => {
    writeNotificationLogMock.mockRejectedValue(new Error("sol-api down"));
    await expect(
      logWriteOutcome(SOL_API_ENV, envelope, { result: { outcome: "succeeded", memberId: "m" } })
    ).resolves.toBeUndefined();
  });
});
