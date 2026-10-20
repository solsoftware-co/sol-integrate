import type { GoogleServiceAccount, GoogleSheetsConfig } from "./sol-api.js";

// Same budget as Mailchimp: Sol Gate runs this call (and its notifications)
// inside its own ~30s waitUntil budget. Worst case per write is token + append
// on the first attempt, then a read-back + append on the retry — 4 × 5s.
const FETCH_TIMEOUT_MS = 5_000;
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Reserved column keys — always filled in by this service, never taken from the request. */
export const TIMESTAMP_COLUMN = "_timestamp";
export const SUBMISSION_ID_COLUMN = "_submissionId";

export class GoogleSheetsError extends Error {
  constructor(
    /** Google's HTTP status, or 0 for a problem found before any request (e.g. a malformed key). */
    public readonly status: number,
    /** Fit for the client-facing form_submission email — never contains credentials. */
    public readonly readableReason: string,
    message?: string
  ) {
    super(message ?? `Google Sheets ${status}: ${readableReason}`);
    this.name = "GoogleSheetsError";
  }

  // A 4xx other than 429 is a problem with the integration's settings
  // (no access, no such spreadsheet or tab, a revoked key) — retrying won't
  // change the answer. So is a bad key we couldn't even sign with.
  get permanent(): boolean {
    if (this.status === 0) return true;
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

// A short reason for a failed write, fit for the client-facing
// form_submission email (SOL-34) — never a raw stack or credential.
export function describeGoogleSheetsError(err: unknown): string {
  if (err instanceof GoogleSheetsError) return err.readableReason;
  if (err instanceof Error && err.name === "AbortError") return "Google Sheets didn't respond in time";
  return "Couldn't reach Google Sheets";
}

export function spreadsheetUrl(config: Pick<GoogleSheetsConfig, "spreadsheetId">): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.spreadsheetId)}/edit`;
}

// ---------------------------------------------------------------------------
// A1 notation

/** "B2" → { column: 2, row: 2 } (1-based). */
export function parseCell(cell: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(cell);
  if (!match) throw new GoogleSheetsError(0, `The table anchor "${cell}" isn't a cell reference like "A1"`);
  const column = [...match[1]].reduce((n, letter) => n * 26 + (letter.charCodeAt(0) - 64), 0);
  return { column, row: Number(match[2]) };
}

/** 1 → "A", 27 → "AA". */
export function columnLetters(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** `'Form submissions'!` — quoted so names with spaces or punctuation work; empty for the first sheet. */
export function sheetPrefix(sheetName: string | null): string {
  return sheetName ? `'${sheetName.replace(/'/g, "''")}'!` : "";
}

function anchorOf(config: GoogleSheetsConfig): string {
  return config.tableAnchor ?? "A1";
}

// ---------------------------------------------------------------------------
// The row

export interface RowContext {
  timestamp: string;
  submissionId?: string;
}

// One cell per column key, in column_mapping order. Reserved keys are filled
// in here; anything else comes from `values`, blank if missing.
export function buildRow(columnMapping: string[], values: Record<string, string>, context: RowContext): string[] {
  return columnMapping.map((key) => {
    if (key === TIMESTAMP_COLUMN) return context.timestamp;
    if (key === SUBMISSION_ID_COLUMN) return context.submissionId ?? "";
    return values[key] ?? "";
  });
}

// ---------------------------------------------------------------------------
// Service-account auth: a self-signed RS256 JWT exchanged for an access
// token (Google's "two-legged OAuth"). google-auth-library — what the old
// notification service used — needs Node APIs Workers don't have, so the JWT
// is signed with WebCrypto.

/** The PEM from either a bare PEM or a whole JSON key file, with escaped newlines restored. */
export function privateKeyPem(key: string): string {
  let pem = key.trim();
  if (pem.startsWith("{")) {
    try {
      pem = String((JSON.parse(pem) as { private_key?: unknown }).private_key ?? "");
    } catch {
      pem = "";
    }
  }
  return pem.replace(/\\n/g, "\n").trim();
}

const MALFORMED_KEY = "The Google service account's private key is malformed";

async function importPrivateKey(key: string): Promise<CryptoKey> {
  const base64 = privateKeyPem(key)
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (err) {
    throw new GoogleSheetsError(0, MALFORMED_KEY, `Couldn't import the service account key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signServiceAccountJwt(account: GoogleServiceAccount, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const privateKey = await importPrivateKey(account.key);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: account.email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 })
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(signature)}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAccessToken(account: GoogleServiceAccount): Promise<string> {
  const assertion = await signServiceAccountJwt(account);
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });

  // OAuth errors are { error, error_description }, e.g. invalid_grant /
  // "Invalid JWT Signature." for a revoked or mismatched key.
  const body = (await response.json().catch(() => null)) as
    | { access_token?: string; error?: string; error_description?: string }
    | null;
  if (!response.ok || !body?.access_token) {
    const technical = [body?.error, body?.error_description].filter(Boolean).join(": ") || `HTTP ${response.status}`;
    const readable =
      response.status >= 400 && response.status < 500
        ? `Google rejected the service account ${account.email} — check its key is current and the account still exists`
        : "Google's sign-in service didn't respond properly";
    throw new GoogleSheetsError(response.status, readable, `Google token exchange ${response.status}: ${technical}`);
  }
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Sheets API

// Google API errors are { error: { code, message, status } }. The reasons
// below cover the misconfigurations we expect; anything else passes Google's
// own message through.
function readableSheetsReason(status: number, message: string, config: GoogleSheetsConfig): string {
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    return "The Google Sheets API isn't enabled in the service account's Google Cloud project";
  }
  if (status === 403) {
    return `The service account ${config.googleServiceAccount.email} can't edit this spreadsheet — share it with that address as an Editor`;
  }
  if (status === 404) return "Spreadsheet not found — check the integration's spreadsheet ID";
  if (status === 400 && /Unable to parse range/i.test(message)) {
    return config.sheetName
      ? `There's no sheet named "${config.sheetName}" in this spreadsheet`
      : `The integration's range isn't valid (${message})`;
  }
  return message || `Unexpected response from Google Sheets (HTTP ${status})`;
}

async function sheetsFetch(token: string, config: GoogleSheetsConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchWithTimeout(`${SHEETS_API}/${encodeURIComponent(config.spreadsheetId)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = body?.error?.message ?? "";
    throw new GoogleSheetsError(
      response.status,
      readableSheetsReason(response.status, message, config),
      `Google Sheets ${response.status}: ${message || response.statusText}`
    );
  }
  return response;
}

// Appends after the last row of the table that starts at the anchor —
// Google's own table detection, same as the old notification service.
// RAW: cell values are stored as-is, so "=IMPORTXML(…)" from a public form
// is text, not a formula.
async function appendValues(token: string, config: GoogleSheetsConfig, row: string[]): Promise<string> {
  const range = encodeURIComponent(`${sheetPrefix(config.sheetName)}${anchorOf(config)}`);
  const response = await sheetsFetch(token, config, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
  const body = (await response.json()) as { updates?: { updatedRange?: string } };
  return body.updates?.updatedRange ?? "";
}

/** The range of the row whose `column` (0-based within the table) holds `value`, if there is one. */
async function findRow(token: string, config: GoogleSheetsConfig, column: number, value: string): Promise<string | undefined> {
  const anchor = parseCell(anchorOf(config));
  const letters = columnLetters(anchor.column + column);
  const range = encodeURIComponent(`${sheetPrefix(config.sheetName)}${letters}${anchor.row}:${letters}`);
  const response = await sheetsFetch(token, config, `/values/${range}?majorDimension=COLUMNS`);
  const body = (await response.json()) as { values?: string[][] };
  const cells = body.values?.[0] ?? [];

  const index = cells.lastIndexOf(value);
  if (index === -1) return undefined;
  const row = anchor.row + index;
  const lastColumn = columnLetters(anchor.column + config.columnMapping.length - 1);
  return `${sheetPrefix(config.sheetName)}${columnLetters(anchor.column)}${row}:${lastColumn}${row}`;
}

export interface AppendRowOptions {
  /** Identifies this row: which column (0-based within the table) holds which unique value. Enables a safe retry. */
  dedupe?: { column: number; value: string };
}

export interface AppendRowResult {
  /** A1 range the row is in, e.g. "'Form submissions'!A12:D12". */
  updatedRange: string;
  /** True when a retry found the row already written by the first attempt, so didn't append it again. */
  deduplicated: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// An append isn't idempotent: if it times out or 5xxs, the row may still
// have landed, and blindly retrying would write it twice. So a retry after
// an append that may have landed first reads the dedupe column back and only
// appends if the row isn't there. Without a dedupe key, such a failure isn't
// retried at all — a missing row beats a duplicate. Failures that can't have
// written anything (getting a token, a 429) are retried freely.
export async function appendRow(config: GoogleSheetsConfig, row: string[], opts: AppendRowOptions = {}): Promise<AppendRowResult> {
  let token: string | undefined;
  let mayHaveLanded = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    let appending = false;
    try {
      token ??= await getAccessToken(config.googleServiceAccount);
      if (mayHaveLanded && opts.dedupe) {
        const existing = await findRow(token, config, opts.dedupe.column, opts.dedupe.value);
        if (existing) return { updatedRange: existing, deduplicated: true };
      }
      appending = true;
      return { updatedRange: await appendValues(token, config, row), deduplicated: false };
    } catch (err) {
      lastError = err;
      if (err instanceof GoogleSheetsError && err.permanent) break;
      if (appending && !(err instanceof GoogleSheetsError && err.status === 429)) {
        mayHaveLanded = true;
        if (!opts.dedupe) break;
      }
    }
  }
  throw lastError;
}

// ENVIRONMENT=development: no request leaves the Worker. Returns the same
// shape as a real write so everything downstream — outcome, url, audit log —
// behaves the same locally.
export async function mockAppendRow(config: GoogleSheetsConfig, _row: string[], _opts: AppendRowOptions = {}): Promise<AppendRowResult> {
  return { updatedRange: `${sheetPrefix(config.sheetName)}${anchorOf(config)}`, deduplicated: false };
}
