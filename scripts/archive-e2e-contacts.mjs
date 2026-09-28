// Archives every sandbox Mailchimp contact the e2e suite created for one PR.
// Run by .github/workflows/cleanup.yml when the PR closes — the suite itself
// leaves its contacts in place while the PR is open, so they can be
// inspected in Mailchimp. Also catches contacts left behind by a run that
// was cancelled or crashed mid-way.
//
//   MAILCHIMP_SANDBOX_API_KEY=… MAILCHIMP_SANDBOX_AUDIENCE_ID=… \
//     node scripts/archive-e2e-contacts.mjs <prNumber>
//
// Plain Node (20+), no dependencies, so the cleanup job needs no `npm ci`.
//
// Archives, never permanently deletes: a permanently deleted address can
// never be re-added through the API. Archived contacts don't count toward
// the Free plan's 250-contact limit.

import { createHash } from "node:crypto";

const prNumber = process.argv[2];
if (!/^\d+$/.test(prNumber ?? "")) {
  console.error("usage: node scripts/archive-e2e-contacts.mjs <prNumber>");
  process.exit(2);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} environment variable is required`);
    process.exit(2);
  }
  return value;
}

const apiKey = requireEnv("MAILCHIMP_SANDBOX_API_KEY");
const audienceId = requireEnv("MAILCHIMP_SANDBOX_AUDIENCE_ID");
const baseUrl = `https://${apiKey.split("-")[1]}.api.mailchimp.com/3.0/lists/${audienceId}/members`;
const headers = { Authorization: `Basic ${Buffer.from(`sol-e2e:${apiKey}`).toString("base64")}` };

// Must match the address format in tests/e2e/fixtures.ts (e2eEmailPrefix).
// The trailing dash keeps PR 1 from matching PR 12's contacts.
const prefix = `e2e+pr${prNumber}-`;

// Test contacts are created as `subscribed`; `pending` is included in case a
// future test uses statusIfNew: "pending". Already-archived contacts aren't
// listed here at all.
const matches = [];
for (const status of ["subscribed", "pending"]) {
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${baseUrl}?status=${status}&count=${pageSize}&offset=${offset}&fields=members.email_address,total_items`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`Mailchimp list members failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const { members, total_items } = await res.json();
    matches.push(...members.map((m) => m.email_address).filter((e) => e.toLowerCase().startsWith(prefix)));
    if (offset + pageSize >= total_items) break;
  }
}

let failed = 0;
for (const email of matches) {
  const hash = createHash("md5").update(email.toLowerCase()).digest("hex");
  const res = await fetch(`${baseUrl}/${hash}`, { method: "DELETE", headers });
  if (res.ok || res.status === 404) {
    console.log(`archived ${email}`);
  } else {
    failed++;
    console.error(`failed to archive ${email}: ${res.status} ${await res.text()}`);
  }
}

console.log(`PR #${prNumber}: ${matches.length - failed} of ${matches.length} e2e contact(s) archived`);
process.exit(failed ? 1 : 0);
