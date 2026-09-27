import { z } from "zod";

// This service is internal-only: its sole caller is Sol Gate (SOL-38), which
// has already validated the public submission against the form's
// payload_schema and mapped it into this integration's shape via
// form_integrations.field_mapping. Validation here guards the contract
// between two services we own, not untrusted input.
//
// Mailchimp's field shape is fixed (unlike Google Sheets, SOL-10), so it's
// validated as part of the envelope — the discriminated union on `type`
// picks the right fields schema. `mergeFields` keys are the audience's merge
// tags as-is (FNAME, LNAME, PHONE, or any custom tag).
export const mailchimpFieldsSchema = z
  .object({
    email: z.string().email(),
    mergeFields: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string().min(1)).optional(),
    /** Only applies when the member doesn't exist yet — an existing member's status is never changed. */
    statusIfNew: z.enum(["subscribed", "pending"]).optional(),
  })
  .strict();

// Optional trace IDs from Sol Gate, stored in the notification_logs metadata
// so one submission can be followed across Sol Gate, sol-integrate and
// sol-notify.
export const requestContextSchema = z.object({
  formId: z.string().uuid(),
  submissionId: z.string().min(1),
});

export const mailchimpEnvelopeSchema = z.object({
  clientId: z.string().min(1),
  type: z.literal("mailchimp"),
  integrationId: z.string().uuid(),
  fields: mailchimpFieldsSchema,
  context: requestContextSchema.optional(),
});

// A one-member discriminated union today — SOL-10 appends a
// googleSheetsEnvelopeSchema to add the Sheets branch, with no changes to
// the Mailchimp path.
export const integrationRequestSchema = z.discriminatedUnion("type", [mailchimpEnvelopeSchema]);

export type MailchimpFields = z.infer<typeof mailchimpFieldsSchema>;
export type RequestContext = z.infer<typeof requestContextSchema>;
export type MailchimpEnvelope = z.infer<typeof mailchimpEnvelopeSchema>;
export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
