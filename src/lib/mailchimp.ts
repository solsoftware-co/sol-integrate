import type { MailchimpConfig } from "./sol-api.js";

const FETCH_TIMEOUT_MS = 10_000;

export class MailchimpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "MailchimpApiError";
  }

  // 4xx other than 429 is a problem with the request itself (invalid email,
  // member in compliance state, bad list ID, revoked key) — retrying won't
  // change the answer. 429/5xx/network errors are worth retrying.
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export function isRetryableMailchimpError(err: unknown): boolean {
  return !(err instanceof MailchimpApiError && err.permanent);
}

export interface ListMemberInput {
  email: string;
  mergeFields?: Record<string, string>;
  tags?: string[];
  statusIfNew?: "subscribed" | "pending";
}

// Mailchimp identifies a list member by the MD5 of their lowercased email.
// Workers' crypto.subtle supports MD5 (non-standard, but available).
export async function subscriberHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mailchimpFetch(config: MailchimpConfig, path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`https://${config.serverPrefix}.api.mailchimp.com/3.0${path}`, {
      ...init,
      headers: {
        // Mailchimp accepts any username with the API key as the password.
        Authorization: `Basic ${btoa(`sol:${config.apiKey}`)}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Mailchimp error bodies are RFC 7807 problem details: { title, detail, status }.
    const problem = (await response.json().catch(() => null)) as { title?: string; detail?: string } | null;
    const message = [problem?.title, problem?.detail].filter(Boolean).join(": ") || response.statusText;
    throw new MailchimpApiError(`Mailchimp ${response.status}: ${message}`, response.status);
  }

  return response;
}

// Add-or-update: PUT on the subscriber hash creates the member if missing
// and updates merge fields if present, so repeat submissions of the same
// email are idempotent rather than a "Member Exists" 400. Tags live on a
// separate endpoint and are only ever added, never removed.
export async function upsertListMember(
  config: MailchimpConfig,
  input: ListMemberInput
): Promise<{ memberId: string }> {
  const hash = await subscriberHash(input.email);
  const memberPath = `/lists/${encodeURIComponent(config.listId)}/members/${hash}`;

  const response = await mailchimpFetch(config, memberPath, {
    method: "PUT",
    body: JSON.stringify({
      email_address: input.email,
      status_if_new: input.statusIfNew ?? "subscribed",
      ...(input.mergeFields && { merge_fields: input.mergeFields }),
    }),
  });
  const member = (await response.json()) as { id: string };

  if (input.tags?.length) {
    await mailchimpFetch(config, `${memberPath}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags: input.tags.map((name) => ({ name, status: "active" })) }),
    });
  }

  return { memberId: member.id };
}
