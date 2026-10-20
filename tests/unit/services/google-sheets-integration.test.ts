import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GoogleSheetsEnvelope } from "../../../src/validators/integration.js";

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

const appendRowMock = vi.fn();
const mockAppendRowMock = vi.fn();
vi.mock("../../../src/lib/google-sheets.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/google-sheets.js")>("../../../src/lib/google-sheets.js");
  return {
    ...actual,
    appendRow: (...args: unknown[]) => appendRowMock(...args),
    mockAppendRow: (...args: unknown[]) => mockAppendRowMock(...args),
  };
});

const { runGoogleSheetsWrite, logGoogleSheetsWriteOutcome } = await import("../../../src/services/google-sheets-integration.js");
const { SolApiNotFoundError } = await import("../../../src/lib/sol-api.js");
const { GoogleSheetsError } = await import("../../../src/lib/google-sheets.js");

const SOL_API = {} as Fetcher;
const SOL_API_ENV = { SOL_API, SOL_API_KEY: "test-key" };
const ENV = { ...SOL_API_ENV, ENVIRONMENT: "staging" as const };
const INTEGRATION_ID = "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b";
const FORM_ID = "0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SERVICE_ACCOUNT_KEY = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n";
const SHEETS_CONFIG = {
  spreadsheetId: "sheet123",
  sheetName: "Leads",
  columnMapping: ["_timestamp", "submitterName", "submitterEmail", "_submissionId"],
  tableAnchor: "A1",
  googleServiceAccount: { email: "writer@proj.iam.gserviceaccount.com", key: SERVICE_ACCOUNT_KEY },
};

const envelope: GoogleSheetsEnvelope = {
  clientId: "acme-corp",
  type: "google_sheets",
  integrationId: INTEGRATION_ID,
  fields: { values: { submitterName: "Jane", submitterEmail: "jane@example.com" } },
  context: { formId: FORM_ID, submissionId: "sub_123" },
};

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION_ID,
    clientId: "acme-corp",
    type: "google_sheets",
    name: "Leads sheet",
    description: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    googleSheets: SHEETS_CONFIG,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00.000Z"));
  getIntegrationMock.mockReset().mockResolvedValue(integration());
  writeNotificationLogMock.mockReset().mockResolvedValue(undefined);
  appendRowMock.mockReset().mockResolvedValue({ updatedRange: "Leads!A5:D5", deduplicated: false });
  mockAppendRowMock.mockReset().mockResolvedValue({ updatedRange: "Leads!A1", deduplicated: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runGoogleSheetsWrite", () => {
  it("looks up the integration through the binding, scoped to the client", async () => {
    await runGoogleSheetsWrite(ENV, envelope);
    expect(getIntegrationMock).toHaveBeenCalledWith(SOL_API, "test-key", "acme-corp", INTEGRATION_ID);
  });

  it("appends the row in column order, deduped on _submissionId, and links to the spreadsheet", async () => {
    const run = await runGoogleSheetsWrite(ENV, envelope);

    expect(appendRowMock).toHaveBeenCalledWith(
      SHEETS_CONFIG,
      ["2026-10-12T10:00:00.000Z", "Jane", "jane@example.com", "sub_123"],
      { dedupe: { column: 3, value: "sub_123" } }
    );
    expect(run).toEqual({
      result: { outcome: "succeeded", url: "https://docs.google.com/spreadsheets/d/sheet123/edit", range: "Leads!A5:D5" },
    });
  });

  it("can't dedupe without a _submissionId column", async () => {
    getIntegrationMock.mockResolvedValue(
      integration({ googleSheets: { ...SHEETS_CONFIG, columnMapping: ["_timestamp", "submitterName"] } })
    );
    await runGoogleSheetsWrite(ENV, envelope);
    expect(appendRowMock.mock.calls[0][2]).toEqual({ dedupe: undefined });
  });

  it("can't dedupe without a submissionId", async () => {
    await runGoogleSheetsWrite(ENV, { ...envelope, context: undefined });
    expect(appendRowMock.mock.calls[0][1]).toEqual(["2026-10-12T10:00:00.000Z", "Jane", "jane@example.com", ""]);
    expect(appendRowMock.mock.calls[0][2]).toEqual({ dedupe: undefined });
  });

  it("reports a deduplicated retry as succeeded, flagged for the audit log", async () => {
    appendRowMock.mockResolvedValue({ updatedRange: "Leads!A5:D5", deduplicated: true });
    const run = await runGoogleSheetsWrite(ENV, envelope);
    expect(run).toMatchObject({ result: { outcome: "succeeded" }, deduplicated: true });
  });

  it("mocks the write in development — Google is never called", async () => {
    const run = await runGoogleSheetsWrite({ ...ENV, ENVIRONMENT: "development" }, envelope);

    expect(appendRowMock).not.toHaveBeenCalled();
    expect(mockAppendRowMock).toHaveBeenCalledTimes(1);
    expect(run.result).toMatchObject({ outcome: "succeeded", range: "Leads!A1" });
  });

  it.each(["preview", "production"] as const)("writes for real in %s", async (environment) => {
    await runGoogleSheetsWrite({ ...ENV, ENVIRONMENT: environment }, envelope);
    expect(appendRowMock).toHaveBeenCalledTimes(1);
    expect(mockAppendRowMock).not.toHaveBeenCalled();
  });

  it("returns failed with a readable reason and keeps the technical error for the log", async () => {
    appendRowMock.mockRejectedValue(
      new GoogleSheetsError(403, "The service account writer@proj.iam.gserviceaccount.com can't edit this spreadsheet — share it with that address as an Editor", "Google Sheets 403: The caller does not have permission")
    );

    const run = await runGoogleSheetsWrite(ENV, envelope);

    expect(run).toEqual({
      result: {
        outcome: "failed",
        url: "https://docs.google.com/spreadsheets/d/sheet123/edit",
        detail: "The service account writer@proj.iam.gserviceaccount.com can't edit this spreadsheet — share it with that address as an Editor",
      },
      errorMessage: "Google Sheets 403: The caller does not have permission",
    });
  });

  it.each([
    ["not found", () => getIntegrationMock.mockRejectedValue(new SolApiNotFoundError("Integration not found: x")), "Integration not found"],
    ["the wrong type", () => getIntegrationMock.mockResolvedValue(integration({ type: "mailchimp", googleSheets: undefined })), "Integration is a mailchimp integration, not Google Sheets"],
    ["not active", () => getIntegrationMock.mockResolvedValue(integration({ status: "disabled" })), "Integration is not active (status: disabled)"],
    ["missing its Google Sheets config", () => getIntegrationMock.mockResolvedValue(integration({ googleSheets: null })), "Integration has no Google Sheets settings configured"],
  ])("returns skipped when the integration is %s", async (_case, arrange, detail) => {
    arrange();

    const run = await runGoogleSheetsWrite(ENV, envelope);

    expect(run).toEqual({ result: { outcome: "skipped", detail } });
    expect(appendRowMock).not.toHaveBeenCalled();
  });

  it("returns failed, not a thrown error, when sol-api can't be reached", async () => {
    getIntegrationMock.mockRejectedValue(new Error("sol-api returned non-JSON (HTTP 530): error code: 1042"));

    const run = await runGoogleSheetsWrite(ENV, envelope);

    expect(run).toEqual({
      result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
      errorMessage: "sol-api returned non-JSON (HTTP 530): error code: 1042",
    });
  });

  it("never puts credentials in the result", async () => {
    appendRowMock.mockRejectedValue(new GoogleSheetsError(0, "The Google service account's private key is malformed"));
    const run = await runGoogleSheetsWrite(ENV, envelope);
    expect(JSON.stringify(run)).not.toContain("PRIVATE KEY");
  });
});

describe("logGoogleSheetsWriteOutcome", () => {
  it("logs IDs, the range and trace context — not the row's values", async () => {
    await logGoogleSheetsWriteOutcome(SOL_API_ENV, envelope, {
      result: { outcome: "succeeded", url: "https://docs.google.com/spreadsheets/d/sheet123/edit", range: "Leads!A5:D5" },
      deduplicated: true,
    });

    expect(writeNotificationLogMock).toHaveBeenCalledWith(SOL_API, "test-key", {
      clientId: "acme-corp",
      workflow: "integration-service",
      eventName: "google_sheets.append_row",
      outcome: "succeeded",
      type: "google_sheets",
      errorMessage: null,
      metadata: {
        integrationId: INTEGRATION_ID,
        range: "Leads!A5:D5",
        deduplicated: true,
        formId: FORM_ID,
        submissionId: "sub_123",
      },
    });
    expect(JSON.stringify(writeNotificationLogMock.mock.calls[0])).not.toContain("jane@example.com");
  });

  it("logs the internal error for a failure", async () => {
    await logGoogleSheetsWriteOutcome(SOL_API_ENV, envelope, {
      result: { outcome: "failed", detail: "Spreadsheet not found — check the integration's spreadsheet ID" },
      errorMessage: "Google Sheets 404: Requested entity was not found.",
    });
    expect(writeNotificationLogMock.mock.calls[0][2]).toMatchObject({
      outcome: "failed",
      errorMessage: "Google Sheets 404: Requested entity was not found.",
    });
  });

  it("does not throw when the log write itself fails", async () => {
    writeNotificationLogMock.mockRejectedValue(new Error("sol-api down"));
    await expect(
      logGoogleSheetsWriteOutcome(SOL_API_ENV, envelope, { result: { outcome: "skipped", detail: "Integration not found" } })
    ).resolves.toBeUndefined();
  });
});
