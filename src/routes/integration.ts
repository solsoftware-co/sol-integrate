import { Hono } from "hono";
import { integrationRequestSchema } from "../validators/integration.js";
import { runMailchimpWrite, logWriteOutcome } from "../services/mailchimp-integration.js";
import { parseEnvironment } from "../lib/environment.js";
import { validationErrorResponse } from "../lib/responses.js";
import { logger } from "../lib/logger.js";
import type { AppEnv } from "../types/index.js";

const integration = new Hono<AppEnv>();

// Called only by Sol Gate, from inside its own backgrounded work after it
// has already answered the browser — so this route performs the write and
// returns the outcome, rather than acknowledging and deferring it. Every
// outcome (succeeded / failed / skipped) is a 200: a failed write is a valid
// result for Sol Gate to report, not a broken request. 422 is reserved for
// a malformed request.
integration.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = integrationRequestSchema.safeParse(body);

  if (!parsed.success) {
    return validationErrorResponse(c, "Validation failed", parsed.error.issues);
  }

  // Only member of the union today is the mailchimp envelope — SOL-10 adds a
  // google_sheets branch here once googleSheetsEnvelopeSchema exists.
  const envelope = parsed.data;
  const solApiEnv = { SOL_API: c.env.SOL_API, SOL_API_KEY: c.env.SOL_API_KEY };

  const run = await runMailchimpWrite(
    { ...solApiEnv, ENVIRONMENT: parseEnvironment(c.env.ENVIRONMENT) },
    envelope
  );

  // A failed write is still a 200, so this line is the only place it shows
  // up as a problem: warn, so a level filter in observability catches it.
  const log = run.result.outcome === "failed" ? logger.warn : logger.info;
  log("integration write finished", {
    requestId: c.get("requestId"),
    clientId: envelope.clientId,
    integrationId: envelope.integrationId,
    type: envelope.type,
    outcome: run.result.outcome,
    ...(envelope.context && { formId: envelope.context.formId, submissionId: envelope.context.submissionId }),
    ...(run.errorMessage && { errorMessage: run.errorMessage }),
  });

  c.executionCtx.waitUntil(logWriteOutcome(solApiEnv, envelope, run));

  return c.json({ success: true, data: run.result }, 200);
});

export default integration;
