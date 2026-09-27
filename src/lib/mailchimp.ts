import type { MailchimpConfig } from "./sol-api.js";

// Kept short on purpose: Sol Gate runs this call (and its notifications)
// inside its own ~30s waitUntil budget. Worst case per write is
// 2 attempts × (member PUT + tags POST) × 5s + backoff ≈ 20s.
const FETCH_TIMEOUT_MS = 5_000;

export class MailchimpApiError extends Error {
  constructor(
    public readonly status: number,
    /** Mailchimp's own problem title/detail — human-readable, never contains credentials. */
    public readonly readableReason: string
  ) {
    super(`Mailchimp ${status}: ${readableReason}`);
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

// A short reason for a failed write, fit for the client-facing
// form_submission email (SOL-34) — never a raw stack or credential.
export function describeMailchimpError(err: unknown): string {
  if (err instanceof MailchimpApiError) return err.readableReason;
  if (err instanceof Error && err.name === "AbortError") return "Mailchimp didn't respond in time";
  return "Couldn't reach Mailchimp";
}

export interface ListMemberInput {
  email: string;
  mergeFields?: Record<string, string>;
  tags?: string[];
  statusIfNew?: "subscribed" | "pending";
}

export interface ListMemberResult {
  memberId: string;
  /** Mailchimp's numeric member id for its admin UI — used to link straight to the member. */
  webId: number;
}

// Mailchimp identifies a list member by the MD5 of their lowercased email.
// Workers' crypto.subtle supports MD5 (non-standard, but available).
export async function subscriberHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", new TextEncoder().encode(email.toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Link to the member in Mailchimp's admin UI.
// TODO(SOL-33): verify this URL shape against a real PUT response's web_id.
export function memberUrl(config: MailchimpConfig, webId: number): string {
  return `https://${config.serverPrefix}.admin.mailchimp.com/lists/members/view?id=${webId}`;
}

// Fallback when there's no member to link to (e.g. the write failed): the
// account's audiences page on the right datacenter.
export function audienceUrl(config: MailchimpConfig): string {
  return `https://${config.serverPrefix}.admin.mailchimp.com/lists/`;
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
    const reason = [problem?.title, problem?.detail].filter(Boolean).join(": ") || response.statusText;
    throw new MailchimpApiError(response.status, reason);
  }

  return response;
}

// Add-or-update: PUT on the subscriber hash creates the member if missing
// and updates merge fields if present, so repeat submissions of the same
// email are idempotent rather than a "Member Exists" 400 — which also makes
// the whole call safe for Sol Gate to retry. Tags live on a separate
// endpoint and are only ever added, never removed.
export async function upsertListMember(config: MailchimpConfig, input: ListMemberInput): Promise<ListMemberResult> {
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
  const member = (await response.json()) as { id: string; web_id: number };

  if (input.tags?.length) {
    await mailchimpFetch(config, `${memberPath}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags: input.tags.map((name) => ({ name, status: "active" })) }),
    });
  }

  return { memberId: member.id, webId: member.web_id };
}

// ENVIRONMENT=development: no request leaves the Worker. Returns the same
// shape as a real write (memberId is the real subscriber hash) so everything
// downstream — outcome, url, audit log — behaves the same locally.
export async function mockUpsertListMember(_config: MailchimpConfig, input: ListMemberInput): Promise<ListMemberResult> {
  return { memberId: await subscriberHash(input.email), webId: 0 };
}
