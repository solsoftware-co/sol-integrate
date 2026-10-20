// Deletes every row the e2e suite appended to the sandbox spreadsheet's E2E
// tab for one PR. Run by .github/workflows/cleanup.yml when the PR closes —
// the suite leaves its rows in place while the PR is open, so they can be
// inspected. Also catches rows left by a run that was cancelled mid-way.
//
//   GOOGLE_SHEETS_SANDBOX_SERVICE_ACCOUNT='<JSON key file>' \
//   GOOGLE_SHEETS_SANDBOX_SPREADSHEET_ID=… \
//     node scripts/delete-e2e-sheet-rows.mjs <prNumber>
//
// Plain Node (20+), no dependencies, so the cleanup job needs no `npm ci`.

import { createSign } from "node:crypto";

const prNumber = process.argv[2];
if (!/^\d+$/.test(prNumber ?? "")) {
  console.error("usage: node scripts/delete-e2e-sheet-rows.mjs <prNumber>");
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

const { client_email, private_key } = JSON.parse(requireEnv("GOOGLE_SHEETS_SANDBOX_SERVICE_ACCOUNT"));
const spreadsheetId = requireEnv("GOOGLE_SHEETS_SANDBOX_SPREADSHEET_ID");

// Must match tests/e2e/fixtures.ts: SHEETS_TAB, and e2eSubmissionPrefix in
// the _submissionId column (D). The trailing dash keeps PR 1 from matching
// PR 12's rows.
const TAB = "E2E";
const prefix = `e2e-pr${prNumber}-`;

const now = Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
  iss: client_email,
  scope: "https://www.googleapis.com/auth/spreadsheets",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 600,
})}`;
const signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
});
if (!tokenRes.ok) {
  console.error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  process.exit(1);
}
const headers = { Authorization: `Bearer ${(await tokenRes.json()).access_token}`, "Content-Type": "application/json" };
const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

async function sheets(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    console.error(`Google Sheets ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

const { sheets: tabs } = await sheets("?fields=sheets.properties(sheetId,title)");
const tab = tabs.find((t) => t.properties.title === TAB);
if (!tab) {
  console.log(`PR #${prNumber}: no ${TAB} tab, nothing to delete`);
  process.exit(0);
}

const { values = [] } = await sheets(`/values/${encodeURIComponent(`'${TAB}'!D:D`)}`);
// Bottom-up, so each deletion leaves the earlier indexes in place.
const indexes = values.flatMap((row, i) => (row[0]?.startsWith(prefix) ? [i] : [])).reverse();

if (indexes.length > 0) {
  await sheets(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: indexes.map((i) => ({
        deleteDimension: { range: { sheetId: tab.properties.sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } },
      })),
    }),
  });
}

console.log(`PR #${prNumber}: ${indexes.length} e2e sheet row(s) deleted`);
