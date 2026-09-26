import { Hono } from "hono";
import { integrationRequestSchema } from "../validators/integration.js";
import {
  prepareMailchimpWrite,
  deliverMailchimpWrite,
  logSkippedWrite,
  IntegrationUnavailableError,
} from "../services/mailchimp-integration.js";
import { SolApiNotFoundError } from "../lib/sol-api.js";
import { notFoundResponse, validationErrorResponse } from "../lib/responses.js";
import { logger } from "../lib/logger.js";
import type { AppEnv } from "../types/index.js";

const integration = new Hono<AppEnv>();

integration.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = integrationRequestSchema.safeParse(body);

  if (!result.success) {
    return validationErrorResponse(c, "Validation failed", result.error.issues);
  }

  // Only member of the union today is the mailchimp envelope — SOL-10 adds a
  // google_sheets branch here once googleSheetsEnvelopeSchema exists.
  const envelope = result.data;

  const solApiEnv = {
    SOL_API_URL: c.env.SOL_API_URL,
    SOL_API_KEY: c.env.SOL_API_KEY,
  };

  let prepared;
  try {
    prepared = await prepareMailchimpWrite(solApiEnv, envelope);
  } catch (err) {
    if (err instanceof SolApiNotFoundError || err instanceof IntegrationUnavailableError) {
      logger.warn("integration write skipped", {
        requestId: c.get("requestId"),
        clientId: envelope.clientId,
        integrationId: envelope.integrationId,
        reason: err.message,
      });
      c.executionCtx.waitUntil(logSkippedWrite(solApiEnv, envelope, err.message));
      return notFoundResponse(c, err.message);
    }
    throw err;
  }

  logger.info("integration write accepted", {
    requestId: c.get("requestId"),
    clientId: prepared.clientId,
    integrationId: prepared.integrationId,
    type: envelope.type,
  });

  // Write + log + notify happen after the response is returned — client
  // sites call this directly on form submit, so they shouldn't be blocked
  // through Mailchimp latency or retry backoff. See src/lib/retry.ts.
  c.executionCtx.waitUntil(
    deliverMailchimpWrite(
      {
        ...solApiEnv,
        SOL_NOTIFY_URL: c.env.SOL_NOTIFY_URL,
        SOL_NOTIFY_API_KEY: c.env.SOL_NOTIFY_API_KEY,
      },
      prepared
    )
  );

  return c.json({ success: true, data: { accepted: true } }, 202);
});

export default integration;
