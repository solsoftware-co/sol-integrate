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

  it("accepts merge fields, tags, statusIfNew and a notification descriptor", () => {
    const result = integrationRequestSchema.safeParse({
      ...valid,
      fields: {
        email: "jane@example.com",
        mergeFields: { FNAME: "Jane", LNAME: "Doe" },
        tags: ["website-signup"],
        statusIfNew: "pending",
      },
      notification: {
        recipients: ["sales@acme.com"],
        subject: "New Mailchimp subscriber",
        cta: { url: "https://mailchimp.com/audience" },
      },
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

  it("rejects a notification descriptor with no recipients", () => {
    expect(
      integrationRequestSchema.safeParse({ ...valid, notification: { recipients: [], subject: "x" } }).success
    ).toBe(false);
  });
});
