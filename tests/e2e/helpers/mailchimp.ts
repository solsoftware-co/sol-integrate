import { createHash } from "node:crypto";

// Talks to the sandbox Mailchimp account directly — the suite's equivalent
// of sol-notify polling Mailtrap: it checks what actually landed in
// Mailchimp, not just what the preview Worker reported, and cleans up after.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function memberUrl(email: string): string {
  const apiKey = requireEnv("MAILCHIMP_SANDBOX_API_KEY");
  const serverPrefix = apiKey.split("-")[1];
  const listId = requireEnv("MAILCHIMP_SANDBOX_AUDIENCE_ID");
  return `https://${serverPrefix}.api.mailchimp.com/3.0/lists/${listId}/members/${subscriberHash(email)}`;
}

function authHeader(): string {
  return `Basic ${Buffer.from(`sol-e2e:${requireEnv("MAILCHIMP_SANDBOX_API_KEY")}`).toString("base64")}`;
}

export function subscriberHash(email: string): string {
  return createHash("md5").update(email.toLowerCase()).digest("hex");
}

export interface MailchimpMember {
  id: string;
  web_id: number;
  email_address: string;
  status: string;
  merge_fields: Record<string, unknown>;
  tags: { id: number; name: string }[];
}

export async function getMember(email: string): Promise<MailchimpMember> {
  const res = await fetch(memberUrl(email), { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`Mailchimp GET member failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as MailchimpMember;
}

// Archive, never permanently delete: a permanently deleted address can never
// be re-added through the API. Archived contacts don't count toward the Free
// plan's 250-contact limit. A 404 (already gone / never created) is fine.
export async function archiveMember(email: string): Promise<void> {
  const res = await fetch(memberUrl(email), { method: "DELETE", headers: { Authorization: authHeader() } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Mailchimp archive failed: ${res.status} ${await res.text()}`);
  }
}
