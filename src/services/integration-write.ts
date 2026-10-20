import { getIntegration, writeNotificationLog, SolApiNotFoundError, type Integration, type NotificationLogEntry } from "../lib/sol-api.js";
import { withRetry } from "../lib/retry.js";
import { logger } from "../lib/logger.js";

// What every integration type has in common: the result returned to Sol
// Gate, the integration lookup, and the backgrounded audit-log write.

export type SolApiEnv = { SOL_API: Fetcher; SOL_API_KEY: string };

export const WORKFLOW = "integration-service";

// One uniform result per integration, returned to Sol Gate for the
// form_submission email's results table (SOL-34). `detail` ends up in a
// client-facing email: short, readable, never credentials. The rest are
// per-type extras Sol Gate drops.
export interface IntegrationResult {
  outcome: "succeeded" | "failed" | "skipped";
  url?: string;
  detail?: string;
  /** Mailchimp: the member's subscriber hash. */
  memberId?: string;
  /** Google Sheets: the A1 range the row was written to. */
  range?: string;
}

export interface IntegrationWriteRun {
  result: IntegrationResult;
  /** Internal error for the audit log only — may be technical, never returned to the caller. */
  errorMessage?: string;
}

export type IntegrationLookup = { found: true; integration: Integration } | { found: false; run: IntegrationWriteRun };

export function skipped(detail: string): IntegrationWriteRun {
  return { result: { outcome: "skipped", detail } };
}

// The board's "Integration found?" step, up to the type-specific checks.
// Not found means "skipped" (sol-api scopes the lookup to the client, so
// another client's integration is "not found" too). sol-api being
// unreachable is "failed" instead: the integration may be fine, we just
// couldn't load it.
export async function loadIntegration(env: SolApiEnv, clientId: string, integrationId: string): Promise<IntegrationLookup> {
  try {
    return { found: true, integration: await getIntegration(env.SOL_API, env.SOL_API_KEY, clientId, integrationId) };
  } catch (err) {
    if (err instanceof SolApiNotFoundError) return { found: false, run: skipped("Integration not found") };
    return {
      found: false,
      run: {
        result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// Best-effort audit trail — called from waitUntil() after the outcome has
// been returned, so a slow or failing log write never delays Sol Gate. A
// failure is logged to console, never re-thrown (and will fail outright if
// clientId itself doesn't exist, since notification_logs.client_id is a
// foreign key).
export async function writeAuditLog(env: SolApiEnv, entry: NotificationLogEntry): Promise<void> {
  try {
    await withRetry(() => writeNotificationLog(env.SOL_API, env.SOL_API_KEY, entry));
  } catch (logErr) {
    logger.error("failed to write integration log to sol-api", {
      clientId: entry.clientId,
      errorMessage: logErr instanceof Error ? logErr.message : String(logErr),
    });
  }
}
