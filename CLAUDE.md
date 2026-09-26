# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Active implementation (SOL-9, Mailchimp first pass). Ticket: https://linear.app/sol-software/issue/SOL-9 — flow is the "Integration Service -- Target Flow" frame on the design board (https://miro.com/app/board/uXjVHolYGyo=/). That frame draws the full target state (Mailchimp **and** Google Sheets branches); Google Sheets is SOL-10 and is not implemented here yet.

## Commands

```bash
npm run dev        # wrangler dev server on http://localhost:8789
npm test           # vitest via @cloudflare/vitest-pool-workers
npm run type-check # tsc --noEmit
npm run deploy     # deploy to Cloudflare Workers
```

## Environments

- **`development`** (local `npm run dev`) — real calls to whatever `SOL_API_URL` / `SOL_NOTIFY_URL` point at (sol-api on :8787, sol-notify on :8788 by default), and **real Mailchimp writes** against whatever credentials the integration row in that sol-api's database holds. There is no mock mode — point local sol-api at a database whose Mailchimp integrations use a test audience.
- **`staging`** (`env.staging`, worker `sol-integrate-staging`) — deployed by `.github/workflows/release.yml` on every merge to `main`.
- **`production`** (`env.production`, worker `sol-integrate`) — same workflow's `deploy-production` job, gated behind the `production` GitHub Environment (required reviewer), after `deploy-staging` succeeds.

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RELEASE_TOKEN`, and per environment (`_STAGING` / `_PRODUCTION`): `API_KEY`, `SOL_API_URL`, `SOL_API_KEY`, `SOL_NOTIFY_URL`, `SOL_NOTIFY_API_KEY`. `SOL_NOTIFY_API_KEY_*` is the value of sol-notify's own inbound `API_KEY` for that environment.

Local secrets go in `.dev.vars` (gitignored, see `.dev.vars.example`).

## Architecture

**Stack**: Hono 4.x → Cloudflare Workers, no database. Integration config (including Mailchimp API keys) and the audit-log trail both live behind `sol-api` (`../sol-api`); notifications are handed off to `sol-notify` (`../sol-notify`). Scaffolded from sol-notify — same layout, middleware, logger, response envelope, and release pipeline.

### Source layout

```
src/
├── index.ts                          # Hono app entry
├── routes/
│   ├── health.ts                       # GET /health (no auth)
│   └── integration.ts                  # POST / — the single integration-write entrypoint
├── validators/integration.ts           # z.discriminatedUnion("type", [mailchimpEnvelopeSchema]) — SOL-10 appends google_sheets
├── services/mailchimp-integration.ts   # prepareMailchimpWrite() (sync) + deliverMailchimpWrite() (backgrounded)
├── lib/
│   ├── sol-api.ts                      # getIntegration(), writeNotificationLog()
│   ├── mailchimp.ts                    # upsertListMember() — PUT member by subscriber hash, then tags
│   ├── sol-notify.ts                   # requestNotification() — POST notification.requested
│   ├── retry.ts                        # withRetry() with shouldRetry — only inside ctx.waitUntil()
│   └── logger.ts                       # structured JSON logger with key/token/secret redaction
├── middleware/{auth,error}.ts          # X-API-Key check, global error envelope
└── types/index.ts                      # Env bindings, AppEnv
```

### Request contract

```json
POST /
X-API-Key: <API_KEY>
{
  "clientId": "acme-corp",
  "type": "mailchimp",
  "integrationId": "<uuid of the integrations row>",
  "fields": {
    "email": "jane@example.com",
    "mergeFields": { "FNAME": "Jane" },   // optional, audience merge tags as-is
    "tags": ["website-signup"],           // optional, only ever added
    "statusIfNew": "subscribed"           // optional, "subscribed" (default) | "pending" (double opt-in)
  },
  "notification": {                       // optional — omit for "no notification needed"
    "recipients": ["sales@acme.com"],
    "subject": "New Mailchimp subscriber",
    "cta": { "url": "https://…", "label": "View audience" }
  }
}
```

Responses: `202` accepted · `401` bad key · `422` envelope/fields invalid · `404` integration not found, wrong type, not `active`, or missing its Mailchimp config · `500` unexpected (e.g. sol-api unreachable).

### Request flow — synchronous vs. backgrounded

**Synchronous**: validate envelope (Mailchimp's field shape is fixed, so fields are validated here too) → `GET /v1/clients/:clientId/integrations/:integrationId` → respond `202`. Unusable integration → `404` plus a backgrounded `skipped` log (the board's "Skip + log").

**Backgrounded** in `c.executionCtx.waitUntil()`: Mailchimp upsert (retried on 429/5xx/network, **not** on other 4xx — those are permanent, e.g. "Member In Compliance State") → `POST /v1/notification-logs` with `type: "mailchimp"`, `workflow: "integration-service"`, `eventName: "mailchimp.upsert_member"`, outcome `succeeded`/`failed` → if `notification` was given and the write succeeded, POST to sol-notify with `emailTemplate: "mailchimp_confirmation"`. A failed sol-notify hand-off is console-logged only; the write's own `succeeded` log stands.

Mailchimp credentials never enter logs: the logger redacts `*key*`/`*token*` keys and log metadata only carries `integrationId`, `listId`, `email`, `tags`, `memberId`.

## Related

- `sol-api` — `GET /v1/clients/:clientId/integrations/:integrationId` (SOL-7), `POST /v1/notification-logs`.
- `sol-notify` — `mailchimp_confirmation` template (SOL-8).
- SOL-10 — Google Sheets branch (config fetched *before* field validation, since required fields come from `column_mapping`).
