import { z } from "zod";

// This service is internal-only: its sole caller is Sol Gate (SOL-38), which
// has already validated the public submission against the form's
// payload_schema and mapped it into this integration's shape via
// form_integrations.field_mapping. Validation here guards the contract
// between two services we own, not untrusted input.
//
// Mailchimp's field shape is fixed, so it's validated as part of the
// envelope — the discriminated union on `type`
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

// Google Sheets (SOL-10): a sheet's columns are whatever the integration's
// column_mapping says, so `values` is keyed by those column keys — Sol Gate
// maps form fields onto them. The row is built in column_mapping order;
// keys it doesn't name are ignored, and a column with no value is left
// blank. Two column keys are reserved and always filled in here, never taken
// from `values`: `_timestamp` (when the row was written) and `_submissionId`
// (context.submissionId — also what makes a retried append safe).
//
// Cell values are written RAW, never parsed as formulas — they come from a
// public form.
export const SHEETS_CELL_MAX_LENGTH = 50_000; // Google Sheets' own per-cell limit

export const googleSheetsFieldsSchema = z
  .object({
    values: z.record(z.string(), z.string().max(SHEETS_CELL_MAX_LENGTH)),
  })
  .strict();

export const googleSheetsEnvelopeSchema = z.object({
  clientId: z.string().min(1),
  type: z.literal("google_sheets"),
  integrationId: z.string().uuid(),
  fields: googleSheetsFieldsSchema,
  context: requestContextSchema.optional(),
});

export const integrationRequestSchema = z.discriminatedUnion("type", [
  mailchimpEnvelopeSchema,
  googleSheetsEnvelopeSchema,
]);

export type MailchimpFields = z.infer<typeof mailchimpFieldsSchema>;
export type RequestContext = z.infer<typeof requestContextSchema>;
export type MailchimpEnvelope = z.infer<typeof mailchimpEnvelopeSchema>;
export type GoogleSheetsFields = z.infer<typeof googleSheetsFieldsSchema>;
export type GoogleSheetsEnvelope = z.infer<typeof googleSheetsEnvelopeSchema>;
export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
