# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Mailchimp first pass (SOL-9), realigned to the Sol Gate design (SOL-33), with per-PR preview envs + a Mailchimp sandbox e2e suite (SOL-20). Tickets: https://linear.app/sol-software/issue/SOL-9, https://linear.app/sol-software/issue/SOL-33, https://linear.app/sol-software/issue/SOL-20. Design: `sol-brain/sol-gate/` (Obsidian vault) — especially `decisions/decision-dumb-internal-services.md` and `02-architecture.md`. Google Sheets is SOL-10 and not implemented here yet.

## Role

**Internal-only.** The single caller is **Sol Gate** (SOL-38), the public front door for client-website form submissions. Sol Gate has already validated the submission against the form's `payload_schema` and mapped it into this integration's shape (`form_integrations.field_mapping`); this service just performs the write and reports what happened. It does **not** notify anyone — Sol Gate notifies the form's channels afterwards, including every integration's outcome (sol-notify's `form_submission` template, SOL-34).

## Commands

```bash
npm run dev        # wrangler dev server on http://localhost:8789
npm test           # unit tests, vitest via @cloudflare/vitest-pool-workers (tests/e2e excluded)
npm run test:e2e   # e2e suite in plain Node against PREVIEW_URL (skips if unset)
npm run type-check # tsc --noEmit
npm run deploy     # deploy to Cloudflare Workers
```

## Environments

`ENVIRONMENT` must be one of `development | preview | staging | production` (`src/lib/environment.ts`, same as sol-notify); anything else 500s every request, including `/health`. It is the only switch for whether Mailchimp writes are real.

| ENVIRONMENT | Mailchimp write | `SOL_API` binding | Public URL |
|---|---|---|---|
| `development` (local `npm run dev`) | **mocked** — no request leaves the Worker; returns the real subscriber hash as `memberId` | `sol-api` (auto-connects to sol-api's local `wrangler dev`) | localhost |
| `preview` (worker `sol-integrate-pr-<N>`, SOL-20) | real — against the **sandbox** Mailchimp account only | `sol-api-dev` | **yes**, API-key protected |
| `staging` (worker `sol-integrate-staging`) | real | `sol-api-staging` | **none** (`workers_dev = false`) |
| `production` (worker `sol-integrate`) | real | `sol-api` | **none** (`workers_dev = false`) |

**Previews** are deployed by `.github/workflows/pr.yml` on every same-repo PR (fork PRs skipped — no secrets) and deleted by `cleanup.yml` on close. The suite expects two sandbox integrations to already exist in `sol-api-dev` — a **one-time setup**, not CI's job: paste `scripts/seed-dev-e2e.sql` into the Neon console's SQL editor (sol-api project, `dev` branch), fill in the sandbox key and audience ID, run it. Re-run it after sol-api's `db:branch:reset`, which wipes them (the suite fails with a pointer back to the script if they're missing). `tests/e2e/smoke.test.ts` then makes real writes to the sandbox audience and checks them through Mailchimp's API (succeeded + merge fields/tags, idempotent update, skipped, failed). Test contacts are `e2e+pr<N>-<runId>@solsoftware.co` and **stay in the audience while the PR is open**, so they can be inspected; `cleanup.yml` archives every `e2e+pr<N>-*` contact when the PR closes (`scripts/archive-e2e-contacts.mjs`), including any left by cancelled runs. Local e2e runs (no `E2E_PR_NUMBER`) use `e2e+local-…` and archive their own contact. Previews are safe to expose because sol-api-dev only holds sandbox integrations.

Staging deploys from `.github/workflows/release.yml` on every merge to `main`; production is the same workflow's `deploy-production` job, gated behind the `production` GitHub Environment (required reviewer).

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RELEASE_TOKEN`, and `API_KEY_STAGING` / `API_KEY_PRODUCTION` (this service's inbound key — Sol Gate sends it) and `SOL_API_KEY_STAGING` / `SOL_API_KEY_PRODUCTION` (sol-api's key). There is no `SOL_API_URL`: sol-api is reached through the `SOL_API` service binding, because a plain `fetch()` between Workers on the same `workers.dev` subdomain fails with Cloudflare `error code: 1042` (see sol-notify's `decision-service-bindings-for-sol-api`).

PR previews add: `SOL_API_KEY_DEV` (sol-api-dev's key), and `MAILCHIMP_SANDBOX_API_KEY` / `MAILCHIMP_SANDBOX_AUDIENCE_ID` (the dedicated sandbox Mailchimp account — Free plan, 250 contacts, double opt-in and automations off; never a client's account), which only the e2e suite (to check members) and `cleanup.yml` (to archive them) use. `API_KEY_STAGING` is reused as the preview Worker's inbound key, as in sol-notify.

Local secrets go in `.dev.vars` (gitignored, see `.dev.vars.example`). Bruno (`bruno/`) has Dev and PR Preview environments — staging and production can't be reached from outside Cloudflare.

## Architecture

**Stack**: Hono 4.x → Cloudflare Workers, no database. Integration config (including Mailchimp API keys) and the audit-log trail both live behind `sol-api` (`../sol-api`). Scaffolded from sol-notify — same layout, middleware, logger, response envelope, and release pipeline.

### Source layout

```
src/
├── index.ts                          # Hono app entry; validates ENVIRONMENT on every request
├── routes/
│   ├── health.ts                       # GET /health (no auth)
│   └── integration.ts                  # POST / — perform one integration write, return its outcome
├── validators/integration.ts           # z.discriminatedUnion("type", [mailchimpEnvelopeSchema]) — SOL-10 appends google_sheets
├── services/mailchimp-integration.ts   # runMailchimpWrite() → outcome; logWriteOutcome() (backgrounded)
├── lib/
│   ├── sol-api.ts                      # getIntegration(), writeNotificationLog() — via the SOL_API binding, text-first parse
│   ├── mailchimp.ts                    # upsertListMember() / mockUpsertListMember(), result links, readable failure reasons
│   ├── environment.ts                  # ENVIRONMENT enum
│   ├── retry.ts                        # withRetry() with shouldRetry
│   ├── log-context.ts                  # environment, traceId, submissionId on every log line (SOL-46)
│   └── logger.ts                       # structured JSON logger with key/token/secret redaction
├── middleware/{auth,error}.ts          # X-API-Key check (second layer behind the binding), global error envelope
└── types/index.ts                      # Env bindings, AppEnv
tests/
├── unit/                               # Workers pool (vitest.config.ts)
└── e2e/                                # plain Node vs. a deployed preview (vitest.e2e.config.ts); fixtures.ts, helpers/mailchimp.ts
scripts/seed-dev-e2e.sql                # one-time setup: sandbox integrations in sol-api-dev (run by hand in the Neon console)
scripts/archive-e2e-contacts.mjs        # archives a PR's e2e contacts; run by cleanup.yml on PR close
```

### Request contract

```json
POST /
X-API-Key: <API_KEY>
{
  "clientId": "acme-corp",
  "type": "mailchimp",
  "integrationId": "<uuid of the integrations row>",
  "fields": {                               // already mapped by Sol Gate into Mailchimp's shape
    "email": "jane@example.com",
    "mergeFields": { "FNAME": "Jane" },     // optional, audience merge tags as-is
    "tags": ["website-signup"],             // optional, only ever added
    "statusIfNew": "subscribed"             // optional, "subscribed" (default) | "pending" (double opt-in)
  },
  "context": { "formId": "<uuid>", "submissionId": "…" }   // optional, stored in the audit log for tracing
}
```

Response — **`200` for every outcome**, since a failed write is a valid result, not a broken request:

```json
{ "success": true, "data": { "outcome": "succeeded", "url": "https://us21.admin.mailchimp.com/lists/members/view?id=…", "memberId": "…" } }
{ "success": true, "data": { "outcome": "failed", "url": "https://us21.admin.mailchimp.com/lists/", "detail": "Member In Compliance State: …" } }
{ "success": true, "data": { "outcome": "skipped", "detail": "Integration is not active (status: disabled)" } }
```

`401` bad key · `422` malformed request · `500` only for something unexpected (or an invalid `ENVIRONMENT`).

- **`skipped`** — the integration can't be used: not found (sol-api scopes the lookup to `clientId`, so another client's integration is "not found" too), wrong type, not `active`, or no Mailchimp config. The form is misconfigured, not the submission.
- **`failed`** — the write was attempted and didn't succeed, or sol-api couldn't be reached to load the config.
- **`detail`** ends up in a client-facing email: always short and readable, never credentials. The technical error goes to the audit log only.
- **`url`** — the member's page in Mailchimp's admin UI (from the PUT response's `web_id`), else the account's audiences page. The `web_id` URL shape is still to be verified against a real response.

### Request flow

1. Validate the envelope (Mailchimp's field shape is fixed, so fields are validated here too).
2. `GET /v1/clients/:clientId/integrations/:integrationId` through `SOL_API` → `skipped` / `failed` if unusable.
3. Upsert the member — `PUT /lists/{listId}/members/{md5(email)}`, then tags. Idempotent, so Sol Gate can safely retry the whole call. Up to **2 attempts**, **5 s timeout** per Mailchimp request; permanent 4xx (other than 429) aren't retried.
4. Respond with the outcome.
5. In `waitUntil()`: `POST /v1/notification-logs` with `type: "mailchimp"`, `workflow: "integration-service"`, `eventName: "mailchimp.upsert_member"`, the outcome, and `{ integrationId, email, tags, memberId?, formId?, submissionId? }` metadata. Best-effort — logged to console on failure, never re-thrown.

**Time budget:** Sol Gate makes this call inside its own `waitUntil`, which Cloudflare allows ~30 s after its response, and its notifications share that budget. Worst case here is ≈20 s (2 attempts × member PUT + tags POST × 5 s). Whether Sol Gate orchestrates through `waitUntil` or Cloudflare Queues / Workflows is decided in SOL-38.

**Tracing (SOL-46):** Every log line carries `environment`, a `traceId` and, for a submission, a `submissionId`. The `traceId` is the caller's `X-Trace-Id` (Sol Gate's, forwarded) or a new one; the `submissionId` is only ever the caller's `X-Submission-Id`, never made up. `lib/log-context.ts` holds them for the request (AsyncLocalStorage, so `waitUntil` work keeps them) and `lib/sol-api.ts` forwards both to sol-api. There is no `requestId`: Cloudflare's own `$metadata.requestId` tells invocations (e.g. a retried call's attempts) apart. `traceId` is one run of work (on every line); `submissionId` is the form submission it's for (only when there is one). A replayed submission would keep its `submissionId` under a new `traceId`. Filter Workers Logs by `submissionId = <id>` for everything that happened to a submission, `traceId = <id>` for one run, or `environment = production`.

Mailchimp credentials never leave the service: the logger redacts `*key*`/`*token*` keys, log metadata carries only IDs, email and tags, and `detail` comes from Mailchimp's own problem title/detail.

## Open

- **Staging e2e:** staging is verified end-to-end through Sol Gate staging (SOL-38) once it exists; until then only PR previews exercise real Mailchimp — accepted, since no real users are on this service yet.
- **`web_id` link:** the e2e suite checks the URL uses the member's real `web_id`; one manual click (the suite logs the link) confirms it opens the right member.

### E2E gotchas

- Mailchimp rejects obviously fake domains (`example.com`), so test contacts are real-domain plus-addresses (`e2e+pr<N>-<runId>@solsoftware.co`, override the domain with `E2E_EMAIL_DOMAIN`). Nothing is sent to them. The address format lives in both `tests/e2e/fixtures.ts` (`e2eEmailPrefix`) and `scripts/archive-e2e-contacts.mjs` — keep them in sync.
- Cleanup **archives** (`DELETE /members/{hash}`), never permanently deletes — a permanently deleted address can never be re-added through the API. Archived contacts don't count toward the 250-contact limit, but **active** ones do: each push to an open PR adds one contact until the PR closes, so many long-lived PRs with many pushes could approach 250.
- Archived contacts are hidden from Mailchimp's default contacts view — filter by *Archived* to see them.
- The fixed integration IDs in `tests/e2e/fixtures.ts` must match `scripts/seed-dev-e2e.sql`.
- Inherited from sol-notify (SOL-17): wrangler 3 rejects `--name` with `--env`, so `pr.yml` rewrites `[env.preview]`'s `name = "sol-integrate-preview"` line — keep it exact. Deploying without `--env` would silently bind **production** sol-api. Secrets go in as one `secret bulk` version, and the e2e waits for `/health` to report that run's exact `APP_VERSION`.

## Related

- Sol Gate (SOL-38) — the only caller.
- `sol-api` — `GET /v1/clients/:clientId/integrations/:integrationId` (SOL-7), `POST /v1/notification-logs`.
- sol-notify `form_submission` template (SOL-34) — renders this service's `outcome` / `url` / `detail`.
- SOL-10 — Google Sheets branch. A Sheets row append is **not** idempotent (a retry duplicates the row), so it needs an idempotency key; it should also accept fields already mapped by Sol Gate.
