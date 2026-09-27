import type { MailchimpEnvelope } from "../validators/integration.js";
import { getIntegration, writeNotificationLog, SolApiNotFoundError, type MailchimpConfig } from "../lib/sol-api.js";
import {
  upsertListMember,
  mockUpsertListMember,
  isRetryableMailchimpError,
  describeMailchimpError,
  memberUrl,
  audienceUrl,
} from "../lib/mailchimp.js";
import type { Environment } from "../lib/environment.js";
import { withRetry } from "../lib/retry.js";
import { logger } from "../lib/logger.js";

type SolApiEnv = { SOL_API: Fetcher; SOL_API_KEY: string };

const WORKFLOW = "integration-service";
const EVENT_NAME = "mailchimp.upsert_member";

// One uniform result per integration, returned to Sol Gate for the
// form_submission email's results table (SOL-34). `detail` ends up in a
// client-facing email: short, readable, never credentials.
export interface IntegrationResult {
  outcome: "succeeded" | "failed" | "skipped";
  url?: string;
  detail?: string;
  memberId?: string;
}

export interface MailchimpWriteRun {
  result: IntegrationResult;
  /** Internal error for the audit log only — may be technical, never returned to the caller. */
  errorMessage?: string;
}

type MailchimpIntegrationLookup =
  | { usable: true; config: MailchimpConfig }
  | { usable: false; run: MailchimpWriteRun };

// The board's "Integration found?" step. Not found, the wrong type, not
// active, or missing its Mailchimp child row all mean "skipped" — the form
// is misconfigured, not the submission. sol-api being unreachable is
// "failed" instead: the integration may be fine, we just couldn't load it.
async function lookUpMailchimpIntegration(
  env: SolApiEnv,
  envelope: MailchimpEnvelope
): Promise<MailchimpIntegrationLookup> {
  const skip = (detail: string): MailchimpIntegrationLookup => ({
    usable: false,
    run: { result: { outcome: "skipped", detail } },
  });

  let integration;
  try {
    integration = await getIntegration(env.SOL_API, env.SOL_API_KEY, envelope.clientId, envelope.integrationId);
  } catch (err) {
    if (err instanceof SolApiNotFoundError) return skip("Integration not found");
    return {
      usable: false,
      run: {
        result: { outcome: "failed", detail: "Couldn't load the integration's settings" },
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (integration.type !== "mailchimp") {
    return skip(`Integration is a ${integration.type} integration, not Mailchimp`);
  }
  if (integration.status !== "active") {
    return skip(`Integration is not active (status: ${integration.status})`);
  }
  if (!("mailchimp" in integration) || !integration.mailchimp) {
    return skip("Integration has no Mailchimp settings configured");
  }
  return { usable: true, config: integration.mailchimp };
}

// Performs the write and returns its outcome. Never throws for an expected
// failure — Sol Gate needs a result for every integration, whatever happened.
export async function runMailchimpWrite(
  env: SolApiEnv & { ENVIRONMENT: Environment },
  envelope: MailchimpEnvelope
): Promise<MailchimpWriteRun> {
  const mailchimpIntegration = await lookUpMailchimpIntegration(env, envelope);
  if (!mailchimpIntegration.usable) return mailchimpIntegration.run;

  const { config } = mailchimpIntegration;
  const upsert = env.ENVIRONMENT === "development" ? mockUpsertListMember : upsertListMember;

  try {
    const member = await withRetry(() => upsert(config, envelope.fields), {
      attempts: 2,
      shouldRetry: isRetryableMailchimpError,
    });
    return {
      result: {
        outcome: "succeeded",
        url: member.webId ? memberUrl(config, member.webId) : audienceUrl(config),
        memberId: member.memberId,
      },
    };
  } catch (err) {
    return {
      result: { outcome: "failed", url: audienceUrl(config), detail: describeMailchimpError(err) },
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// Best-effort audit trail — called from waitUntil() after the outcome has
// been returned, so a slow or failing log write never delays Sol Gate. A
// failure is logged to console, never re-thrown (and will fail outright if
// clientId itself doesn't exist, since notification_logs.client_id is a
// foreign key).
export async function logWriteOutcome(env: SolApiEnv, envelope: MailchimpEnvelope, run: MailchimpWriteRun): Promise<void> {
  try {
    await withRetry(() =>
      writeNotificationLog(env.SOL_API, env.SOL_API_KEY, {
        clientId: envelope.clientId,
        workflow: WORKFLOW,
        eventName: EVENT_NAME,
        outcome: run.result.outcome,
        type: "mailchimp",
        errorMessage: run.errorMessage ?? run.result.detail ?? null,
        metadata: {
          integrationId: envelope.integrationId,
          email: envelope.fields.email,
          tags: envelope.fields.tags ?? [],
          ...(run.result.memberId && { memberId: run.result.memberId }),
          ...(envelope.context && { formId: envelope.context.formId, submissionId: envelope.context.submissionId }),
        },
      })
    );
  } catch (logErr) {
    logger.error("failed to write integration log to sol-api", {
      clientId: envelope.clientId,
      errorMessage: logErr instanceof Error ? logErr.message : String(logErr),
    });
  }
}
