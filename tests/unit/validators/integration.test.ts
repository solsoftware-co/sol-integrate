import { describe, it, expect } from "vitest";
import { integrationRequestSchema } from "../../../src/validators/integration.js";

const valid = {
  clientId: "acme-corp",
  type: "mailchimp",
  integrationId: "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b",
  fields: { email: "jane@example.com" },
};

describe("integrationRequestSchema", () => {
  it("accepts a minimal mailchimp envelope", () => {
    expect(integrationRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts merge fields, tags, statusIfNew and trace context", () => {
    const result = integrationRequestSchema.safeParse({
      ...valid,
      fields: {
        email: "jane@example.com",
        mergeFields: { FNAME: "Jane", LNAME: "Doe" },
        tags: ["website-signup"],
        statusIfNew: "pending",
      },
      context: { formId: "0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b", submissionId: "sub_123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(integrationRequestSchema.safeParse({ ...valid, type: "hubspot" }).success).toBe(false);
  });

  it("rejects a non-uuid integrationId", () => {
    expect(integrationRequestSchema.safeParse({ ...valid, integrationId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(integrationRequestSchema.safeParse({ ...valid, fields: { email: "nope" } }).success).toBe(false);
  });

  // Mailchimp's shape is fixed — a stray field is a caller bug, not something to silently drop.
  it("rejects unknown fields keys", () => {
    expect(
      integrationRequestSchema.safeParse({ ...valid, fields: { email: "jane@example.com", FNAME: "Jane" } }).success
    ).toBe(false);
  });

  it("rejects a context with a non-uuid formId", () => {
    expect(
      integrationRequestSchema.safeParse({ ...valid, context: { formId: "form-1", submissionId: "sub_123" } }).success
    ).toBe(false);
  });

  // Notifications moved to Sol Gate (SOL-33) — an old-style block is dropped, never acted on.
  it("strips a notification block rather than acting on it", () => {
    const result = integrationRequestSchema.safeParse({
      ...valid,
      notification: { recipients: ["sales@acme.com"], subject: "x" },
    });
    expect(result.success).toBe(true);
    expect(result.success && "notification" in result.data).toBe(false);
  });

  describe("google_sheets", () => {
    const sheets = {
      clientId: "acme-corp",
      type: "google_sheets",
      integrationId: "4f1c2a9e-8b3d-4e5f-9a6b-7c8d9e0f1a2b",
      fields: { values: { submitterName: "Jane", submitterEmail: "jane@example.com" } },
      context: { formId: "0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b", submissionId: "sub_123" },
    };

    it("accepts values keyed by column key", () => {
      expect(integrationRequestSchema.safeParse(sheets).success).toBe(true);
    });

    it("accepts empty values — every column is then blank or reserved", () => {
      expect(integrationRequestSchema.safeParse({ ...sheets, fields: { values: {} } }).success).toBe(true);
    });

    it("rejects non-string values — Sol Gate sends display strings", () => {
      expect(integrationRequestSchema.safeParse({ ...sheets, fields: { values: { age: 42 } } }).success).toBe(false);
    });

    it("rejects a value over Google Sheets' 50,000-character cell limit", () => {
      const result = integrationRequestSchema.safeParse({ ...sheets, fields: { values: { message: "x".repeat(50_001) } } });
      expect(result.success).toBe(false);
    });

    it("rejects Mailchimp-shaped fields and unknown fields keys", () => {
      expect(integrationRequestSchema.safeParse({ ...sheets, fields: { email: "jane@example.com" } }).success).toBe(false);
      expect(integrationRequestSchema.safeParse({ ...sheets, fields: { values: {}, row: [] } }).success).toBe(false);
    });
  });
});
