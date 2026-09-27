// Typed HTTP client for sol-api. This service holds no database of its own —
// integration config (including credentials) and the audit-log trail both
// live behind sol-api, reached through the SOL_API service binding (see
// wrangler.toml) with X-API-Key auth.

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

// Requests go through the binding, never the public internet — the host in
// this base URL is ignored by a service binding; only the path matters.
const BINDING_BASE_URL = "https://sol-api";

async function solApiFetch<T>(
  solApi: Fetcher,
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await solApi.fetch(`${BINDING_BASE_URL}${path}`, {
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

  // Read as text first so a non-JSON response (e.g. a Cloudflare error page
  // like "error code: 1042") surfaces with its status and body, rather than
  // as an opaque JSON SyntaxError.
  const text = await response.text();
  let body: ApiEnvelope<T>;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new Error(`sol-api returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200).trim()}`);
  }

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
  solApi: Fetcher,
  apiKey: string,
  clientId: string,
  integrationId: string
): Promise<Integration> {
  return solApiFetch<Integration>(
    solApi,
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
  solApi: Fetcher,
  apiKey: string,
  entry: NotificationLogEntry
): Promise<void> {
  await solApiFetch<unknown>(solApi, apiKey, "/v1/notification-logs", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}
