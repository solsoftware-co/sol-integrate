import { z } from "zod";

// Mailchimp's field shape is fixed (unlike Google Sheets, SOL-10, whose
// required fields depend on each integration's stored column_mapping), so it
// can be validated as part of the envelope itself, before the integration
// config is ever fetched — the discriminated union on `type` picks the right
// fields schema. `mergeFields` keys are the audience's merge tags as-is
// (FNAME, LNAME, PHONE, or any custom tag).
export const mailchimpFieldsSchema = z
  .object({
    email: z.string().email(),
    mergeFields: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string().min(1)).optional(),
    /** Only applies when the member doesn't exist yet — an existing member's status is never changed. */
    statusIfNew: z.enum(["subscribed", "pending"]).optional(),
  })
  .strict();

// Optional: when present, a successful write is followed by a
// notification.requested POST to sol-notify. Omitted means "write only, no
// notification needed". Shape mirrors the parts of sol-notify's email
// envelope the caller actually decides — clientId/type/emailTemplate/fields
// are filled in by this service.
export const notificationDescriptorSchema = z.object({
  recipients: z.array(z.string().min(1)).min(1),
  subject: z.string().min(1),
  cta: z
    .object({
      url: z.string().url(),
      label: z.string().min(1).optional(),
    })
    .optional(),
});

export const mailchimpEnvelopeSchema = z.object({
  clientId: z.string().min(1),
  type: z.literal("mailchimp"),
  integrationId: z.string().uuid(),
  fields: mailchimpFieldsSchema,
  notification: notificationDescriptorSchema.optional(),
});

// A one-member discriminated union today — SOL-10 appends a
// googleSheetsEnvelopeSchema to add the Sheets branch, with no changes to
// the Mailchimp path.
export const integrationRequestSchema = z.discriminatedUnion("type", [mailchimpEnvelopeSchema]);

export type MailchimpFields = z.infer<typeof mailchimpFieldsSchema>;
export type NotificationDescriptor = z.infer<typeof notificationDescriptorSchema>;
export type MailchimpEnvelope = z.infer<typeof mailchimpEnvelopeSchema>;
export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
