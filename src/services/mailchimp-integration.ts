import type { MailchimpEnvelope, MailchimpFields, NotificationDescriptor } from "../validators/integration.js";
import { getIntegration, writeNotificationLog, type MailchimpConfig } from "../lib/sol-api.js";
import { upsertListMember, isRetryableMailchimpError } from "../lib/mailchimp.js";
import { requestNotification, isRetryableSolNotifyError } from "../lib/sol-notify.js";
import { withRetry } from "../lib/retry.js";
import { logger } from "../lib/logger.js";

type SolApiEnv = { SOL_API_URL: string; SOL_API_KEY: string };
type DeliverEnv = SolApiEnv & { SOL_NOTIFY_URL: string; SOL_NOTIFY_API_KEY: string };

const WORKFLOW = "integration-service";
const EVENT_NAME = "mailchimp.upsert_member";

// The integration exists in sol-api but can't be written to: wrong type for
// this envelope, not active, or missing its mailchimp_integrations child row.
// Treated the same as not-found — the board's "Integration found? → no" path.
export class IntegrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationUnavailableError";
  }
}

export interface PreparedMailchimpWrite {
  clientId: string;
  integrationId: string;
  config: MailchimpConfig;
  fields: MailchimpFields;
  notification?: NotificationDescriptor;
}

// Synchronous half: fetch the integration config and confirm it's usable.
// Propagates SolApiNotFoundError / IntegrationUnavailableError so the route
// can surface a 404 immediately — a caller pointing at the wrong integration
// is a "this request is broken" condition, not something to defer.
export async function prepareMailchimpWrite(
  env: SolApiEnv,
  envelope: MailchimpEnvelope
): Promise<PreparedMailchimpWrite> {
  const integration = await getIntegration(env.SOL_API_URL, env.SOL_API_KEY, envelope.clientId, envelope.integrationId);

  if (integration.type !== "mailchimp") {
    throw new IntegrationUnavailableError(
      `Integration ${envelope.integrationId} is type "${integration.type}", not "mailchimp"`
    );
  }
  if (integration.status !== "active") {
    throw new IntegrationUnavailableError(
      `Integration ${envelope.integrationId} is not active (status: ${integration.status})`
    );
  }
  if (!("mailchimp" in integration) || !integration.mailchimp) {
    throw new IntegrationUnavailableError(`Integration ${envelope.integrationId} has no Mailchimp config`);
  }

  return {
    clientId: envelope.clientId,
    integrationId: envelope.integrationId,
    config: integration.mailchimp,
    fields: envelope.fields,
    notification: envelope.notification,
  };
}

// Backgrounded half: called from inside ctx.waitUntil(), after the response
// has already been sent. Write (retried, except permanent 4xx) → log outcome
// → on success, hand off to sol-notify if a notification was requested.
export async function deliverMailchimpWrite(env: DeliverEnv, prepared: PreparedMailchimpWrite): Promise<void> {
  let memberId: string;
  try {
    ({ memberId } = await withRetry(() => upsertListMember(prepared.config, prepared.fields), {
      shouldRetry: isRetryableMailchimpError,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("mailchimp write failed permanently", {
      clientId: prepared.clientId,
      integrationId: prepared.integrationId,
      errorMessage: message,
    });
    await logOutcome(env, prepared.clientId, "failed", {
      errorMessage: message,
      metadata: writeMetadata(prepared),
    });
    return;
  }

  await logOutcome(env, prepared.clientId, "succeeded", {
    metadata: { ...writeMetadata(prepared), memberId },
  });

  await notify(env, prepared);
}

// Board's "Integration found? → no → Skip + log" — the route has already
// responded 404; this just leaves the audit trail. Best-effort like every
// other log write (and will fail outright if clientId itself doesn't exist,
// since notification_logs.client_id is a foreign key).
export async function logSkippedWrite(
  env: SolApiEnv,
  envelope: MailchimpEnvelope,
  reason: string
): Promise<void> {
  await logOutcome(env, envelope.clientId, "skipped", {
    errorMessage: reason,
    metadata: { integrationId: envelope.integrationId, email: envelope.fields.email },
  });
}

// No notification descriptor means "write only" — the board's
// "Notification descriptor provided? → no → Done" path.
async function notify(
  env: DeliverEnv,
  { clientId, integrationId, fields, notification }: PreparedMailchimpWrite
): Promise<void> {
  if (!notification) return;

  try {
    await withRetry(
      () =>
        requestNotification(env.SOL_NOTIFY_URL, env.SOL_NOTIFY_API_KEY, {
          clientId,
          type: "email",
          recipients: notification.recipients,
          subject: notification.subject,
          emailTemplate: "mailchimp_confirmation",
          fields: toNotificationFields(fields),
          ...(notification.cta && { cta: notification.cta }),
        }),
      { shouldRetry: isRetryableSolNotifyError }
    );
  } catch (err) {
    // The Mailchimp write itself already succeeded and is logged as such —
    // a failed hand-off doesn't change that outcome, so console only.
    // sol-notify logs its own delivery outcomes once it has accepted.
    logger.error("failed to request notification from sol-notify", {
      clientId,
      integrationId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

// Mailchimp's default merge tags, given readable labels — mailchimp_confirmation
// renders `fields` keys verbatim as labels. Custom tags pass through as-is.
const MERGE_TAG_LABELS: Record<string, string> = {
  FNAME: "First name",
  LNAME: "Last name",
  PHONE: "Phone",
  ADDRESS: "Address",
  BIRTHDAY: "Birthday",
};

export function toNotificationFields(fields: MailchimpFields): Record<string, string> {
  const result: Record<string, string> = { Email: fields.email };
  for (const [tag, value] of Object.entries(fields.mergeFields ?? {})) {
    result[MERGE_TAG_LABELS[tag] ?? tag] = value;
  }
  if (fields.tags?.length) {
    result.Tags = fields.tags.join(", ");
  }
  return result;
}

function writeMetadata(prepared: PreparedMailchimpWrite): Record<string, unknown> {
  return {
    integrationId: prepared.integrationId,
    listId: prepared.config.listId,
    email: prepared.fields.email,
    tags: prepared.fields.tags ?? [],
  };
}

async function logOutcome(
  env: SolApiEnv,
  clientId: string,
  outcome: "succeeded" | "failed" | "skipped",
  extra: { errorMessage?: string; metadata: Record<string, unknown> }
): Promise<void> {
  try {
    await withRetry(() =>
      writeNotificationLog(env.SOL_API_URL, env.SOL_API_KEY, {
        clientId,
        workflow: WORKFLOW,
        eventName: EVENT_NAME,
        outcome,
        type: "mailchimp",
        errorMessage: extra.errorMessage ?? null,
        metadata: extra.metadata,
      })
    );
  } catch (logErr) {
    logger.error("failed to write integration log to sol-api", {
      clientId,
      errorMessage: logErr instanceof Error ? logErr.message : String(logErr),
    });
  }
}
