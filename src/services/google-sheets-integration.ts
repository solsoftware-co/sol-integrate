import type { GoogleSheetsEnvelope } from "../validators/integration.js";
import type { GoogleSheetsConfig } from "../lib/sol-api.js";
import {
  appendRow,
  mockAppendRow,
  buildRow,
  describeGoogleSheetsError,
  spreadsheetUrl,
  SUBMISSION_ID_COLUMN,
} from "../lib/google-sheets.js";
import type { Environment } from "../lib/environment.js";
import {
  loadIntegration,
  skipped,
  writeAuditLog,
  WORKFLOW,
  type IntegrationWriteRun,
  type SolApiEnv,
} from "./integration-write.js";

const EVENT_NAME = "google_sheets.append_row";

export interface GoogleSheetsWriteRun extends IntegrationWriteRun {
  /** The retry found the row already written by the first attempt — for the audit log. */
  deduplicated?: boolean;
}

type GoogleSheetsIntegrationLookup =
  | { usable: true; config: GoogleSheetsConfig }
  | { usable: false; run: GoogleSheetsWriteRun };

// Same rules as Mailchimp's: anything that makes the integration unusable
// is "skipped" — the form is misconfigured, not the submission.
async function lookUpGoogleSheetsIntegration(
  env: SolApiEnv,
  envelope: GoogleSheetsEnvelope
): Promise<GoogleSheetsIntegrationLookup> {
  const lookup = await loadIntegration(env, envelope.clientId, envelope.integrationId);
  if (!lookup.found) return { usable: false, run: lookup.run };
  const { integration } = lookup;

  if (integration.type !== "google_sheets") {
    return { usable: false, run: skipped(`Integration is a ${integration.type} integration, not Google Sheets`) };
  }
  if (integration.status !== "active") {
    return { usable: false, run: skipped(`Integration is not active (status: ${integration.status})`) };
  }
  if (!("googleSheets" in integration) || !integration.googleSheets) {
    return { usable: false, run: skipped("Integration has no Google Sheets settings configured") };
  }
  return { usable: true, config: integration.googleSheets };
}

// Performs the write and returns its outcome. Never throws for an expected
// failure — Sol Gate needs a result for every integration, whatever happened.
export async function runGoogleSheetsWrite(
  env: SolApiEnv & { ENVIRONMENT: Environment },
  envelope: GoogleSheetsEnvelope
): Promise<GoogleSheetsWriteRun> {
  const sheetsIntegration = await lookUpGoogleSheetsIntegration(env, envelope);
  if (!sheetsIntegration.usable) return sheetsIntegration.run;

  const { config } = sheetsIntegration;
  const submissionId = envelope.context?.submissionId;
  const row = buildRow(config.columnMapping, envelope.fields.values, { timestamp: new Date().toISOString(), submissionId });

  // A retry is only safe when the row can be recognised afterwards: the
  // sheet needs a _submissionId column, and the caller needs to have sent one.
  const submissionIdColumn = config.columnMapping.indexOf(SUBMISSION_ID_COLUMN);
  const dedupe = submissionId && submissionIdColumn !== -1 ? { column: submissionIdColumn, value: submissionId } : undefined;

  const append = env.ENVIRONMENT === "development" ? mockAppendRow : appendRow;

  try {
    const written = await append(config, row, { dedupe });
    return {
      result: { outcome: "succeeded", url: spreadsheetUrl(config), range: written.updatedRange },
      ...(written.deduplicated && { deduplicated: true }),
    };
  } catch (err) {
    return {
      result: { outcome: "failed", url: spreadsheetUrl(config), detail: describeGoogleSheetsError(err) },
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// Best-effort audit trail, from waitUntil() — see writeAuditLog(). Only IDs
// and the range go in the metadata, not the row: its values are whatever the
// form collected (messages, phone numbers), and the sheet already has them.
export async function logGoogleSheetsWriteOutcome(
  env: SolApiEnv,
  envelope: GoogleSheetsEnvelope,
  run: GoogleSheetsWriteRun
): Promise<void> {
  await writeAuditLog(env, {
    clientId: envelope.clientId,
    workflow: WORKFLOW,
    eventName: EVENT_NAME,
    outcome: run.result.outcome,
    type: "google_sheets",
    errorMessage: run.errorMessage ?? run.result.detail ?? null,
    metadata: {
      integrationId: envelope.integrationId,
      ...(run.result.range && { range: run.result.range }),
      ...(run.deduplicated && { deduplicated: true }),
      ...(envelope.context && { formId: envelope.context.formId, submissionId: envelope.context.submissionId }),
    },
  });
}
