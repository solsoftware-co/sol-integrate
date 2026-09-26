// Typed HTTP client for sol-notify's notification.requested entrypoint
// (POST /). sol-notify validates + renders synchronously and responds 202,
// then delivers in the background — so a success here means "accepted", not
// "delivered". Delivery outcome is logged by sol-notify itself.

const FETCH_TIMEOUT_MS = 10_000;

export interface EmailNotificationRequest {
  clientId: string;
  type: "email";
  recipients: string[];
  subject: string;
  emailTemplate: "mailchimp_confirmation";
  fields: Record<string, string>;
  cta?: { url: string; label?: string };
}

export class SolNotifyRejectedError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "SolNotifyRejectedError";
  }
}

export async function requestNotification(
  baseUrl: string,
  apiKey: string,
  request: EmailNotificationRequest
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new SolNotifyRejectedError(
      `sol-notify ${response.status}: ${body?.error?.message ?? response.statusText}`,
      response.status
    );
  }
}

// A 4xx from sol-notify (bad recipients, unknown client) won't change on retry.
export function isRetryableSolNotifyError(err: unknown): boolean {
  return !(err instanceof SolNotifyRejectedError && err.status >= 400 && err.status < 500);
}
