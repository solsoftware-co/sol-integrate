import { createSign } from "node:crypto";
import { SHEETS_TAB } from "../fixtures.js";

// Talks to the sandbox spreadsheet directly with the sandbox service account
// — like helpers/mailchimp.ts, it checks what actually landed in the sheet,
// not just what the preview Worker reported. Plain Node, so the JWT is signed
// with node:crypto rather than the Worker's WebCrypto code.

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function sandboxSpreadsheetId(): string {
  return requireEnv("GOOGLE_SHEETS_SANDBOX_SPREADSHEET_ID");
}

async function accessToken(): Promise<string> {
  const { client_email, private_key } = JSON.parse(requireEnv("GOOGLE_SHEETS_SANDBOX_SERVICE_ACCOUNT")) as {
    client_email: string;
    private_key: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function sheets(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SHEETS_API}/${sandboxSpreadsheetId()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Google Sheets ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Every row of the E2E tab, as displayed (FORMATTED_VALUE — so a formula would show its result). */
export async function readRows(): Promise<string[][]> {
  const body = await sheets(`/values/${encodeURIComponent(`'${SHEETS_TAB}'!A:D`)}`);
  return body.values ?? [];
}

/** Deletes every E2E-tab row whose _submissionId (column D) starts with `prefix`. */
export async function deleteRowsWithSubmissionPrefix(prefix: string): Promise<number> {
  const { sheets: tabs } = await sheets("?fields=sheets.properties(sheetId,title)");
  const tab = tabs.find((t: any) => t.properties.title === SHEETS_TAB);
  if (!tab) return 0;

  const rows = await readRows();
  const indexes = rows.flatMap((row, i) => (row[3]?.startsWith(prefix) ? [i] : [])).reverse();
  if (indexes.length === 0) return 0;

  // Bottom-up, so each deletion leaves the earlier indexes in place.
  await sheets(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: indexes.map((i) => ({
        deleteDimension: { range: { sheetId: tab.properties.sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } },
      })),
    }),
  });
  return indexes.length;
}
