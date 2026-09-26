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
vi.mock("../../../src/lib/mailchimp.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/mailchimp.js")>("../../../src/lib/mailchimp.js");
  return { ...actual, upsertListMember: (...args: unknown[]) => upsertListMemberMock(...args) };
});

const requestNotificationMock = vi.fn();
vi.mock("../../../src/lib/sol-notify.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/sol-notify.js")>("../../../src/lib/sol-notify.js");
  return { ...actual, requestNotification: (...args: unknown[]) => requestNotificationMock(...args) };
});

const { prepareMailchimpWrite, deliverMailchimpWrite, logSkippedWrite, toNotificationFields, IntegrationUnavailableError } =
  await import("../../../src/services/mailchimp-integration.js");
const { SolApiNotFoundError } = await import("../../../src/lib/sol-api.js");
const { MailchimpApiError } = await import("../../../src/lib/mailchimp.js");
const { SolNotifyRejectedError } = await import("../../../src/lib/sol-notify.js");

const SOL_API_ENV = { SOL_API_URL: "https://sol-api.test", SOL_API_KEY: "test-key" };
const FULL_ENV = { ...SOL_API_ENV, SOL_NOTIFY_URL: "https://sol-notify.test", SOL_NOTIFY_API_KEY: "notify-key" };
const INTEGRATION_ID = "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b";
const MAILCHIMP_CONFIG = { apiKey: "abc123-us21", listId: "list42", serverPrefix: "us21" };

const baseEnvelope: MailchimpEnvelope = {
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
  getIntegrationMock.mockReset();
  writeNotificationLogMock.mockReset().mockResolvedValue(undefined);
  upsertListMemberMock.mockReset();
  requestNotificationMock.mockReset().mockResolvedValue(undefined);
  getIntegrationMock.mockResolvedValue(integration());
});

describe("prepareMailchimpWrite", () => {
  it("fetches the integration and returns its Mailchimp config", async () => {
    const prepared = await prepareMailchimpWrite(SOL_API_ENV, baseEnvelope);
    expect(getIntegrationMock).toHaveBeenCalledWith("https://sol-api.test", "test-key", "acme-corp", INTEGRATION_ID);
    expect(prepared.config).toEqual(MAILCHIMP_CONFIG);
    expect(prepared.fields).toEqual(baseEnvelope.fields);
  });

  it("propagates SolApiNotFoundError for an unknown integration", async () => {
    getIntegrationMock.mockRejectedValue(new SolApiNotFoundError("Integration not found"));
    await expect(prepareMailchimpWrite(SOL_API_ENV, baseEnvelope)).rejects.toBeInstanceOf(SolApiNotFoundError);
  });

  it("rejects an integration of a different type", async () => {
    getIntegrationMock.mockResolvedValue(integration({ type: "google_sheets", mailchimp: undefined }));
    await expect(prepareMailchimpWrite(SOL_API_ENV, baseEnvelope)).rejects.toBeInstanceOf(IntegrationUnavailableError);
  });

  it("rejects an inactive integration", async () => {
    getIntegrationMock.mockResolvedValue(integration({ status: "disabled" }));
    await expect(prepareMailchimpWrite(SOL_API_ENV, baseEnvelope)).rejects.toThrow(/not active/);
  });

  it("rejects an integration missing its Mailchimp child config", async () => {
    getIntegrationMock.mockResolvedValue(integration({ mailchimp: null }));
    await expect(prepareMailchimpWrite(SOL_API_ENV, baseEnvelope)).rejects.toThrow(/no Mailchimp config/);
  });
});

describe("deliverMailchimpWrite", () => {
  const prepared = {
    clientId: "acme-corp",
    integrationId: INTEGRATION_ID,
    config: MAILCHIMP_CONFIG,
    fields: baseEnvelope.fields,
  };

  it("writes to Mailchimp and logs success, with no notification when none was requested", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1" });

    await deliverMailchimpWrite(FULL_ENV, prepared);

    expect(upsertListMemberMock).toHaveBeenCalledWith(MAILCHIMP_CONFIG, baseEnvelope.fields);
    expect(writeNotificationLogMock).toHaveBeenCalledTimes(1);
    expect(writeNotificationLogMock.mock.calls[0][2]).toMatchObject({
      clientId: "acme-corp",
      workflow: "integration-service",
      eventName: "mailchimp.upsert_member",
      outcome: "succeeded",
      type: "mailchimp",
      metadata: { integrationId: INTEGRATION_ID, listId: "list42", email: "jane@example.com", memberId: "member-1" },
    });
    expect(requestNotificationMock).not.toHaveBeenCalled();
  });

  it("never logs Mailchimp credentials", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1" });
    await deliverMailchimpWrite(FULL_ENV, prepared);
    expect(JSON.stringify(writeNotificationLogMock.mock.calls)).not.toContain(MAILCHIMP_CONFIG.apiKey);
  });

  it("requests a mailchimp_confirmation email from sol-notify after a successful write", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1" });

    await deliverMailchimpWrite(FULL_ENV, {
      ...prepared,
      notification: {
        recipients: ["sales@acme.com"],
        subject: "New Mailchimp subscriber",
        cta: { url: "https://mailchimp.com/audience", label: "Open audience" },
      },
    });

    expect(requestNotificationMock).toHaveBeenCalledWith("https://sol-notify.test", "notify-key", {
      clientId: "acme-corp",
      type: "email",
      recipients: ["sales@acme.com"],
      subject: "New Mailchimp subscriber",
      emailTemplate: "mailchimp_confirmation",
      fields: { Email: "jane@example.com", "First name": "Jane" },
      cta: { url: "https://mailchimp.com/audience", label: "Open audience" },
    });
  });

  it("logs failure without retrying or notifying on a permanent Mailchimp error", async () => {
    upsertListMemberMock.mockRejectedValue(new MailchimpApiError("Mailchimp 400: Invalid Resource", 400));

    await deliverMailchimpWrite(FULL_ENV, {
      ...prepared,
      notification: { recipients: ["sales@acme.com"], subject: "x" },
    });

    expect(upsertListMemberMock).toHaveBeenCalledTimes(1);
    expect(writeNotificationLogMock.mock.calls[0][2]).toMatchObject({
      outcome: "failed",
      errorMessage: "Mailchimp 400: Invalid Resource",
    });
    expect(requestNotificationMock).not.toHaveBeenCalled();
  });

  it("retries a transient Mailchimp error before succeeding", async () => {
    upsertListMemberMock
      .mockRejectedValueOnce(new MailchimpApiError("Mailchimp 503: down", 503))
      .mockResolvedValue({ memberId: "member-1" });

    await deliverMailchimpWrite(FULL_ENV, prepared);

    expect(upsertListMemberMock).toHaveBeenCalledTimes(2);
    expect(writeNotificationLogMock.mock.calls[0][2].outcome).toBe("succeeded");
  });

  it("swallows a sol-notify rejection — the write already succeeded", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1" });
    requestNotificationMock.mockRejectedValue(new SolNotifyRejectedError("sol-notify 422: bad", 422));

    await expect(
      deliverMailchimpWrite(FULL_ENV, { ...prepared, notification: { recipients: ["sales@acme.com"], subject: "x" } })
    ).resolves.toBeUndefined();
    expect(requestNotificationMock).toHaveBeenCalledTimes(1);
    expect(writeNotificationLogMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the log write itself fails", async () => {
    upsertListMemberMock.mockResolvedValue({ memberId: "member-1" });
    writeNotificationLogMock.mockRejectedValue(new Error("sol-api down"));
    await expect(deliverMailchimpWrite(FULL_ENV, prepared)).resolves.toBeUndefined();
  });
});

describe("logSkippedWrite", () => {
  it("writes a skipped outcome with the reason", async () => {
    await logSkippedWrite(SOL_API_ENV, baseEnvelope, "Integration not found");
    expect(writeNotificationLogMock.mock.calls[0][2]).toMatchObject({
      clientId: "acme-corp",
      outcome: "skipped",
      errorMessage: "Integration not found",
      metadata: { integrationId: INTEGRATION_ID, email: "jane@example.com" },
    });
  });
});

describe("toNotificationFields", () => {
  it("labels default merge tags, passes custom ones through, and joins tags", () => {
    expect(
      toNotificationFields({
        email: "jane@example.com",
        mergeFields: { FNAME: "Jane", LNAME: "Doe", COMPANY: "Acme" },
        tags: ["website", "promo"],
      })
    ).toEqual({
      Email: "jane@example.com",
      "First name": "Jane",
      "Last name": "Doe",
      COMPANY: "Acme",
      Tags: "website, promo",
    });
  });
});
