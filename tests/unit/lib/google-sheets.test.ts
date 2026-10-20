import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import {
  appendRow,
  mockAppendRow,
  buildRow,
  columnLetters,
  parseCell,
  sheetPrefix,
  privateKeyPem,
  signServiceAccountJwt,
  getAccessToken,
  spreadsheetUrl,
  describeGoogleSheetsError,
  GoogleSheetsError,
} from "../../../src/lib/google-sheets.js";
import type { GoogleSheetsConfig } from "../../../src/lib/sol-api.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function googleError(status: number, message: string): Response {
  return json({ error: { code: status, message, status: "X" } }, status);
}

// A real RSA key, generated once, so the JWT is genuinely signed and verified.
let publicKey: CryptoKey;
let pem: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
});

function config(overrides: Partial<GoogleSheetsConfig> = {}): GoogleSheetsConfig {
  return {
    spreadsheetId: "sheet123",
    sheetName: "Form submissions",
    columnMapping: ["_timestamp", "submitterName", "_submissionId"],
    tableAnchor: "B2",
    googleServiceAccount: { email: "writer@proj.iam.gserviceaccount.com", key: pem },
    ...overrides,
  };
}

const tokenResponse = () => json({ access_token: "ya29.token", expires_in: 3599, token_type: "Bearer" });
const appended = (range = "'Form submissions'!B7:D7") => json({ updates: { updatedRange: range, updatedRows: 1 } });

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/")));
}

describe("A1 helpers", () => {
  it.each([
    [1, "A"],
    [26, "Z"],
    [27, "AA"],
    [52, "AZ"],
    [703, "AAA"],
  ])("column %i is %s, and back", (column, letters) => {
    expect(columnLetters(column)).toBe(letters);
    expect(parseCell(`${letters}1`)).toEqual({ column, row: 1 });
  });

  it("parses the row too", () => {
    expect(parseCell("B12")).toEqual({ column: 2, row: 12 });
  });

  it("rejects something that isn't a cell reference", () => {
    expect(() => parseCell("b2")).toThrow(GoogleSheetsError);
  });

  it("quotes sheet names, doubling single quotes, and leaves the first sheet unprefixed", () => {
    expect(sheetPrefix("Form submissions")).toBe("'Form submissions'!");
    expect(sheetPrefix("Jane's leads")).toBe("'Jane''s leads'!");
    expect(sheetPrefix(null)).toBe("");
  });
});

describe("buildRow", () => {
  it("orders cells by column mapping, fills reserved keys, and blanks missing values", () => {
    const row = buildRow(
      ["_timestamp", "submitterName", "phone", "_submissionId"],
      { submitterName: "Jane", unmapped: "ignored" },
      { timestamp: "2026-10-12T10:00:00.000Z", submissionId: "sub_1" }
    );
    expect(row).toEqual(["2026-10-12T10:00:00.000Z", "Jane", "", "sub_1"]);
  });

  it("never takes reserved keys from the submitted values", () => {
    const row = buildRow(["_timestamp", "_submissionId"], { _timestamp: "spoofed", _submissionId: "spoofed" }, { timestamp: "t" });
    expect(row).toEqual(["t", ""]);
  });
});

describe("service-account auth", () => {
  it("accepts a bare PEM, a JSON key file, and escaped newlines", () => {
    const keyFile = JSON.stringify({ type: "service_account", private_key: pem });
    expect(privateKeyPem(pem)).toBe(pem.trim());
    expect(privateKeyPem(keyFile)).toBe(pem.trim());
    expect(privateKeyPem(pem.replace(/\n/g, "\\n"))).toBe(pem.trim());
  });

  it("signs an RS256 JWT for the Sheets scope that verifies with the public key", async () => {
    const jwt = await signServiceAccountJwt({ email: "writer@proj.iam.gserviceaccount.com", key: pem }, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");

    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims)).toEqual({
      iss: "writer@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, sig, new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it("treats a malformed key as a permanent failure, without calling Google", async () => {
    const err = await getAccessToken({ email: "w@p.iam.gserviceaccount.com", key: "not a key" }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleSheetsError);
    expect(err.permanent).toBe(true);
    expect(err.readableReason).toBe("The Google service account's private key is malformed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the JWT for an access token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    expect(await getAccessToken({ email: "w@p.iam.gserviceaccount.com", key: pem })).toBe("ya29.token");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init.body.toString());
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("explains a rejected key without leaking it", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    const err = await getAccessToken({ email: "w@p.iam.gserviceaccount.com", key: pem }).catch((e) => e);
    expect(err.permanent).toBe(true);
    expect(err.readableReason).toContain("Google rejected the service account w@p.iam.gserviceaccount.com");
    expect(err.message).toContain("invalid_grant: Invalid JWT Signature.");
    expect(JSON.stringify(err)).not.toContain("PRIVATE KEY");
  });
});

describe("appendRow", () => {
  const row = ["2026-10-12T10:00:00.000Z", "Jane", "sub_1"];
  const dedupe = { column: 2, value: "sub_1" };

  it("appends RAW to the table at the anchor, on the named sheet", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(appended());

    const result = await appendRow(config(), row, { dedupe });

    expect(result).toEqual({ updatedRange: "'Form submissions'!B7:D7", deduplicated: false });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/${encodeURIComponent("'Form submissions'!B2")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
    );
    expect(init.headers.Authorization).toBe("Bearer ya29.token");
    expect(JSON.parse(init.body)).toEqual({ values: [row] });
  });

  it("uses the first sheet and A1 when neither is set", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(appended("Sheet1!A5:C5"));
    await appendRow(config({ sheetName: null, tableAnchor: null }), row);
    expect(fetchMock.mock.calls[1][0]).toContain("/values/A1:append?");
  });

  it("on a 5xx, reads the submissionId column back and doesn't append twice if the row landed", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(googleError(503, "The service is currently unavailable."))
      .mockResolvedValueOnce(json({ range: "'Form submissions'!D2:D9", majorDimension: "COLUMNS", values: [["Submission", "sub_0", "sub_1"]] }));

    const result = await appendRow(config(), row, { dedupe });

    expect(result).toEqual({ updatedRange: "'Form submissions'!B4:D4", deduplicated: true });
    expect(fetchMock).toHaveBeenCalledTimes(3); // token reused, no second append
    expect(fetchMock.mock.calls[2][0]).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/sheet123/values/${encodeURIComponent("'Form submissions'!D2:D")}?majorDimension=COLUMNS`
    );
  });

  it("on a timeout, appends again if the read-back doesn't find the row", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(json({ values: [["Submission", "sub_0"]] }))
      .mockResolvedValueOnce(appended());

    const result = await appendRow(config(), row, { dedupe });

    expect(result.deduplicated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("handles an empty column on read-back", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(googleError(500, "Internal error"))
      .mockResolvedValueOnce(json({ range: "'Form submissions'!D2:D" }))
      .mockResolvedValueOnce(appended());

    expect((await appendRow(config(), row, { dedupe })).deduplicated).toBe(false);
  });

  it("doesn't retry an append that may have landed when there's no way to recognise the row", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(googleError(503, "Unavailable"));

    await expect(appendRow(config(), row)).rejects.toThrow("Google Sheets 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 without a read-back — a rate-limited append wrote nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(googleError(429, "Quota exceeded"))
      .mockResolvedValueOnce(appended());

    const result = await appendRow(config(), row);

    expect(result.deduplicated).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://oauth2.googleapis.com/token",
      expect.stringContaining(":append?"),
      expect.stringContaining(":append?"),
    ]);
  });

  it("retries a failed token exchange", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "internal_failure" }, 503))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(appended());

    expect((await appendRow(config(), row)).deduplicated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after 2 attempts", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(googleError(503, "Unavailable"))
      .mockResolvedValueOnce(json({ values: [[]] }))
      .mockResolvedValueOnce(googleError(503, "Unavailable"));

    await expect(appendRow(config(), row, { dedupe })).rejects.toThrow("Google Sheets 503");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [403, "The caller does not have permission", "The service account writer@proj.iam.gserviceaccount.com can't edit this spreadsheet — share it with that address as an Editor"],
    [403, "Google Sheets API has not been used in project 123 before or it is disabled.", "The Google Sheets API isn't enabled in the service account's Google Cloud project"],
    [404, "Requested entity was not found.", "Spreadsheet not found — check the integration's spreadsheet ID"],
    [400, "Unable to parse range: 'Form submissions'!B2", 'There\'s no sheet named "Form submissions" in this spreadsheet'],
  ])("fails a %i at once with a readable reason (%s)", async (status, message, readable) => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(googleError(status, message));

    const err = await appendRow(config(), row, { dedupe }).catch((e) => e);

    expect(err).toBeInstanceOf(GoogleSheetsError);
    expect(err.readableReason).toBe(readable);
    expect(err.message).toBe(`Google Sheets ${status}: ${message}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("mockAppendRow", () => {
  it("never calls Google", async () => {
    expect(await mockAppendRow(config(), ["x"])).toEqual({ updatedRange: "'Form submissions'!B2", deduplicated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("result helpers", () => {
  it("links to the spreadsheet", () => {
    expect(spreadsheetUrl(config())).toBe("https://docs.google.com/spreadsheets/d/sheet123/edit");
  });

  it("describes failures readably", () => {
    expect(describeGoogleSheetsError(new GoogleSheetsError(404, "Spreadsheet not found"))).toBe("Spreadsheet not found");
    expect(describeGoogleSheetsError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("Google Sheets didn't respond in time");
    expect(describeGoogleSheetsError(new TypeError("fetch failed"))).toBe("Couldn't reach Google Sheets");
  });
});
