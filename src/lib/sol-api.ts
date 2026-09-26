// Typed HTTP client for sol-api. This service holds no database of its own —
// integration config (including credentials) and the audit-log trail both
// live behind sol-api, reached over HTTP with X-API-Key auth.

const FETCH_TIMEOUT_MS = 10_000;

type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: unknown } };

export class SolApiNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolApiNotFoundError";
  }
}

async function solApiFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const body = (await response.json()) as ApiEnvelope<T>;

  if (!body.success) {
    if (response.status === 404) {
      throw new SolApiNotFoundError(body.error.message);
    }
    throw new Error(body.error.message);
  }

  return body.data;
}

// Mirrors sol-api's services/integrations.ts response types. `mailchimp` is
// null when the base row exists but its child config row doesn't.
interface IntegrationBase {
  id: string;
  clientId: string;
  type: string;
  name: string | null;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailchimpConfig {
  apiKey: string;
  listId: string;
  serverPrefix: string;
}

export interface MailchimpIntegration extends IntegrationBase {
  type: "mailchimp";
  mailchimp: MailchimpConfig | null;
}

export type Integration = MailchimpIntegration | IntegrationBase;

export async function getIntegration(
  baseUrl: string,
  apiKey: string,
  clientId: string,
  integrationId: string
): Promise<Integration> {
  return solApiFetch<Integration>(
    baseUrl,
    apiKey,
    `/v1/clients/${encodeURIComponent(clientId)}/integrations/${encodeURIComponent(integrationId)}`
  );
}

export interface NotificationLogEntry {
  clientId: string;
  workflow: string;
  eventName: string;
  outcome: string;
  type: string;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeNotificationLog(
  baseUrl: string,
  apiKey: string,
  entry: NotificationLogEntry
): Promise<void> {
  await solApiFetch<unknown>(baseUrl, apiKey, "/v1/notification-logs", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}
