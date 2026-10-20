import type { MailchimpEnvelope } from "../validators/integration.js";
import type { MailchimpConfig } from "../lib/sol-api.js";
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
import {
  loadIntegration,
  skipped,
  writeAuditLog,
  WORKFLOW,
  type IntegrationWriteRun,
  type SolApiEnv,
} from "./integration-write.js";

const EVENT_NAME = "mailchimp.upsert_member";

export type MailchimpWriteRun = IntegrationWriteRun;

type MailchimpIntegrationLookup =
  | { usable: true; config: MailchimpConfig }
  | { usable: false; run: MailchimpWriteRun };

// Not found, the wrong type, not active, or missing its Mailchimp child row
// all mean "skipped" — the form is misconfigured, not the submission.
async function lookUpMailchimpIntegration(
  env: SolApiEnv,
  envelope: MailchimpEnvelope
): Promise<MailchimpIntegrationLookup> {
  const lookup = await loadIntegration(env, envelope.clientId, envelope.integrationId);
  if (!lookup.found) return { usable: false, run: lookup.run };
  const { integration } = lookup;

  if (integration.type !== "mailchimp") {
    return { usable: false, run: skipped(`Integration is a ${integration.type} integration, not Mailchimp`) };
  }
  if (integration.status !== "active") {
    return { usable: false, run: skipped(`Integration is not active (status: ${integration.status})`) };
  }
  if (!("mailchimp" in integration) || !integration.mailchimp) {
    return { usable: false, run: skipped("Integration has no Mailchimp settings configured") };
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

// Best-effort audit trail, from waitUntil() — see writeAuditLog().
export async function logWriteOutcome(env: SolApiEnv, envelope: MailchimpEnvelope, run: MailchimpWriteRun): Promise<void> {
  await writeAuditLog(env, {
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
  });
}
