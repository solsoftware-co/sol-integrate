import { describe, it, expect, afterAll } from "vitest";
import { readRows, deleteRowsWithSubmissionPrefix, sandboxSpreadsheetId } from "./helpers/google-sheets.js";
import {
  CLIENT_ID,
  WORKING_INTEGRATION_ID,
  SHEETS_INTEGRATION_ID,
  SHEETS_MISSING_SPREADSHEET_INTEGRATION_ID,
  SHEETS_TAB,
  e2eSubmissionPrefix,
} from "./fixtures.js";

// Real appends to the sandbox spreadsheet's E2E tab (SOL-10). The seeded
// integration's column_mapping is ["_timestamp", "name", "email",
// "_submissionId"], anchored at A1.

const PREVIEW_URL = process.env.PREVIEW_URL;
const API_KEY = process.env.API_KEY_STAGING;
const PR_NUMBER = process.env.E2E_PR_NUMBER || undefined;

const runId = crypto.randomUUID().slice(0, 8);
// Set by pr.yml. In a PR run the row stays in the sheet so it can be
// inspected while the PR is open; cleanup.yml deletes every row for the PR
// when it closes. Local runs delete their own row.
const submissionId = `${e2eSubmissionPrefix(PR_NUMBER)}${runId}`;
let wrote = false;

async function write(integrationId: string, values: Record<string, string>) {
  const res = await fetch(`${PREVIEW_URL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY! },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      type: "google_sheets",
      integrationId,
      fields: { values },
      context: { formId: "e2e00000-0000-4000-8000-00000000f0f0", submissionId },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  return body.data;
}

describe.skipIf(!PREVIEW_URL)("E2E Google Sheets (sandbox spreadsheet)", () => {
  afterAll(async () => {
    if (wrote && !PR_NUMBER) await deleteRowsWithSubmissionPrefix(submissionId);
  });

  it("succeeded — appends one row in column order, with values stored as text", async () => {
    const email = `e2e-${runId}@solsoftware.co`;
    // "=1+1" checks values are written RAW: as a formula it would display "2".
    const result = await write(SHEETS_INTEGRATION_ID, { name: "=1+1", email, notAColumn: "ignored" });
    wrote = true;

    if (result.outcome === "skipped" && result.detail === "Integration not found") {
      throw new Error(
        "The sandbox Sheets integrations aren't in sol-api-dev. sol-api seeds them (db/seeds/e2e/) on every merge to its main; " +
        "to re-seed now, run its 'Seed Dev' workflow from the Actions tab (e.g. after a `db:branch:reset`)."
      );
    }
    expect(result).toMatchObject({
      outcome: "succeeded",
      url: `https://docs.google.com/spreadsheets/d/${sandboxSpreadsheetId()}/edit`,
    });
    expect(result.range).toMatch(new RegExp(`^'?${SHEETS_TAB}'?!A\\d+:D\\d+$`));
    expect(result.detail).toBeUndefined();

    const rows = (await readRows()).filter((row) => row[3] === submissionId);
    expect(rows).toHaveLength(1);
    const [timestamp, name, writtenEmail] = rows[0];
    expect(name).toBe("=1+1");
    expect(writtenEmail).toBe(email);
    expect(Math.abs(Date.now() - Date.parse(timestamp))).toBeLessThan(5 * 60_000);
    console.log(`Row for a manual check: ${result.url} (${result.range})`);
  });

  it("skipped — a Mailchimp integration sent as google_sheets", async () => {
    const result = await write(WORKING_INTEGRATION_ID, { name: "never written" });
    expect(result).toEqual({ outcome: "skipped", detail: "Integration is a mailchimp integration, not Google Sheets" });
  });

  it("failed — a spreadsheet that doesn't exist, with a readable detail and no credentials", async () => {
    const result = await write(SHEETS_MISSING_SPREADSHEET_INTEGRATION_ID, { name: "never written" });

    expect(result.outcome).toBe("failed");
    expect(result.url).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/.+\/edit$/);
    expect(result.detail).toBe("Spreadsheet not found — check the integration's spreadsheet ID");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });
});
