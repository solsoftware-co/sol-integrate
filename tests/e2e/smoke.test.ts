import { describe, it, expect, afterAll } from "vitest";
import { getMember, archiveMember, subscriberHash } from "./helpers/mailchimp.js";
import {
  CLIENT_ID,
  WORKING_INTEGRATION_ID,
  BROKEN_KEY_INTEGRATION_ID,
  MISSING_INTEGRATION_ID,
  e2eEmailPrefix,
} from "./fixtures.js";

const PREVIEW_URL = process.env.PREVIEW_URL;
const API_KEY = process.env.API_KEY_STAGING;
// Mailchimp rejects obviously fake domains like example.com, so test
// contacts use real-domain plus-addresses. Nothing is ever sent to them:
// status_if_new is "subscribed" and the sandbox audience has double opt-in
// and automations off.
const EMAIL_DOMAIN = process.env.E2E_EMAIL_DOMAIN ?? "solsoftware.co";

const skip = !PREVIEW_URL;

function post(body: unknown, headers: Record<string, string> = { "X-API-Key": API_KEY! }) {
  return fetch(`${PREVIEW_URL}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function envelope(integrationId: string, fields: Record<string, unknown>) {
  return {
    clientId: CLIENT_ID,
    type: "mailchimp",
    integrationId,
    fields,
    context: { formId: "e2e00000-0000-4000-8000-00000000f0f0", submissionId: `e2e-${runId}` },
  };
}

async function write(integrationId: string, fields: Record<string, unknown>) {
  const res = await post(envelope(integrationId, fields));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  return body.data;
}

// Set by pr.yml. In a PR run, the contact is left in place so it can be
// inspected in Mailchimp while the PR is open; cleanup.yml archives every
// contact for the PR when it closes. Local runs have no cleanup pipeline
// behind them, so they archive their own contact.
const PR_NUMBER = process.env.E2E_PR_NUMBER || undefined;

// Unique per run, so runs sharing one sandbox audience never touch each
// other's contact, and a PR reopened after cleanup never hits its own
// archived contact.
const runId = crypto.randomUUID().slice(0, 8);
const email = `${e2eEmailPrefix(PR_NUMBER)}${runId}@${EMAIL_DOMAIN}`;
let created = false;

describe.skipIf(skip)("E2E smoke tests", () => {
  afterAll(async () => {
    if (created && !PR_NUMBER) await archiveMember(email);
  });

  it("GET /health returns 200 in the preview environment", async () => {
    const res = await fetch(`${PREVIEW_URL}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ success: true, data: { status: "ok", environment: "preview" } });
  });

  it("returns 401 without an API key", async () => {
    const res = await post(envelope(WORKING_INTEGRATION_ID, { email }), {});
    expect(res.status).toBe(401);
  });

  it("returns 422 for a malformed request", async () => {
    const res = await post({ type: "mailchimp" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  describe("real Mailchimp writes (sandbox audience)", () => {
    it("succeeded — adds the member with merge fields and a tag", async () => {
      const result = await write(WORKING_INTEGRATION_ID, {
        email,
        mergeFields: { FNAME: "E2E", LNAME: runId },
        tags: ["e2e"],
      });
      created = true;

      if (result.outcome === "skipped" && result.detail === "Integration not found") {
        throw new Error(
          "The sandbox integrations aren't in sol-api-dev. Run scripts/seed-dev-e2e.sql once in the " +
            "Neon console (dev branch) — needed again after sol-api's `db:branch:reset`."
        );
      }
      expect(result.outcome).toBe("succeeded");
      expect(result.memberId).toBe(subscriberHash(email));
      expect(result.detail).toBeUndefined();

      const member = await getMember(email);
      expect(member.status).toBe("subscribed");
      expect(member.merge_fields).toMatchObject({ FNAME: "E2E", LNAME: runId });
      expect(member.tags.map((t) => t.name)).toContain("e2e");

      // The link is built from the PUT response's web_id — check it's the
      // member's real one, not the audiences-page fallback.
      expect(member.web_id).toBeGreaterThan(0);
      expect(result.url).toMatch(
        new RegExp(`^https://[a-z0-9]+\\.admin\\.mailchimp\\.com/lists/members/view\\?id=${member.web_id}$`)
      );
      console.log(`Member link for a manual check: ${result.url}`);
    });

    it("succeeded — a repeat write updates the same member (idempotent upsert)", async () => {
      const result = await write(WORKING_INTEGRATION_ID, {
        email,
        mergeFields: { FNAME: "E2E Updated", LNAME: runId },
      });

      expect(result.outcome).toBe("succeeded");
      expect(result.memberId).toBe(subscriberHash(email));

      const member = await getMember(email);
      expect(member.merge_fields).toMatchObject({ FNAME: "E2E Updated" });
      expect(member.tags.map((t) => t.name)).toContain("e2e"); // tags are add-only
    });

    it("skipped — an integration that doesn't exist", async () => {
      const result = await write(MISSING_INTEGRATION_ID, { email });
      expect(result).toEqual({ outcome: "skipped", detail: "Integration not found" });
    });

    it("failed — Mailchimp rejects the key, with a readable detail and no credentials", async () => {
      const result = await write(BROKEN_KEY_INTEGRATION_ID, { email });

      expect(result.outcome).toBe("failed");
      expect(result.url).toMatch(/^https:\/\/[a-z0-9]+\.admin\.mailchimp\.com\/lists\/$/);
      expect(typeof result.detail).toBe("string");
      expect(result.detail).not.toMatch(/^Mailchimp \d{3}/); // readable, not the internal message
      expect(JSON.stringify(result)).not.toContain(process.env.MAILCHIMP_SANDBOX_API_KEY!);
      expect(JSON.stringify(result)).not.toContain("00000000000000000000000000000000");
      console.log(`Broken-key detail: ${result.detail}`);
    });
  });
});
