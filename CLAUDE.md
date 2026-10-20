# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Mailchimp first pass (SOL-9), realigned to the Sol Gate design (SOL-33), with per-PR preview envs + a sandbox e2e suite (SOL-20), and Google Sheets (SOL-10). Tickets: https://linear.app/sol-software/issue/SOL-9, https://linear.app/sol-software/issue/SOL-33, https://linear.app/sol-software/issue/SOL-20, https://linear.app/sol-software/issue/SOL-10. Design: `sol-brain/sol-gate/` (Obsidian vault) — especially `decisions/decision-dumb-internal-services.md` and `02-architecture.md`.

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

`ENVIRONMENT` must be one of `development | preview | staging | production` (`src/lib/environment.ts`, same as sol-notify); anything else 500s every request, including `/health`. It is the only switch for whether integration writes are real.

| ENVIRONMENT | Mailchimp / Google Sheets write | `SOL_API` binding | Public URL |
|---|---|---|---|
| `development` (local `npm run dev`) | **mocked** — no request leaves the Worker; Mailchimp returns the real subscriber hash as `memberId`, Sheets returns the anchor as `range` | `sol-api` (auto-connects to sol-api's local `wrangler dev`) | localhost |
| `preview` (worker `sol-integrate-pr-<N>`, SOL-20) | real — against the **sandbox** Mailchimp account and sandbox spreadsheet only | `sol-api-dev` | **yes**, API-key protected |
| `staging` (worker `sol-integrate-staging`) | real | `sol-api-staging` | **none** (`workers_dev = false`) |
| `production` (worker `sol-integrate`) | real | `sol-api` | **none** (`workers_dev = false`) |

**Previews** are deployed by `.github/workflows/pr.yml` on every same-repo PR (fork PRs skipped — no secrets) and deleted by `cleanup.yml` on close. The suite expects four sandbox integrations (two Mailchimp, two Google Sheets) to already exist in `sol-api-dev`. **sol-api owns that seed** (`sol-api/db/seeds/e2e/sol-integrate.ts`, SOL-10): its `release.yml` upserts them on every merge to its `main`, and its **Seed Dev** workflow re-seeds on demand, e.g. after `db:branch:reset` wipes them. This repo's CI never touches a database (the suite fails with a pointer to the Seed Dev workflow if they're missing). `tests/e2e/smoke.test.ts` then makes real writes to the sandbox audience and checks them through Mailchimp's API (succeeded + merge fields/tags, idempotent update, skipped, failed). Test contacts are `e2e+pr<N>-<runId>@solsoftware.co` and **stay in the audience while the PR is open**, so they can be inspected; `cleanup.yml` archives every `e2e+pr<N>-*` contact when the PR closes (`scripts/archive-e2e-contacts.mjs`), including any left by cancelled runs. Local e2e runs (no `E2E_PR_NUMBER`) use `e2e+local-…` and archive their own contact. `tests/e2e/google-sheets.test.ts` does the same for Sheets: it appends to the sandbox spreadsheet's `E2E` tab and reads the row back (succeeded + column order + values stored as text, skipped, failed); its rows carry `_submissionId` `e2e-pr<N>-<runId>`, stay while the PR is open, and are deleted by `cleanup.yml` on close (`scripts/delete-e2e-sheet-rows.mjs`). Previews are safe to expose because sol-api-dev only holds sandbox integrations.

Staging deploys from `.github/workflows/release.yml` on every merge to `main`; production is the same workflow's `deploy-production` job, gated behind the `production` GitHub Environment (required reviewer).

GitHub secrets required: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RELEASE_TOKEN`, and `API_KEY_STAGING` / `API_KEY_PRODUCTION` (this service's inbound key — Sol Gate sends it) and `SOL_API_KEY_STAGING` / `SOL_API_KEY_PRODUCTION` (sol-api's key). There is no `SOL_API_URL`: sol-api is reached through the `SOL_API` service binding, because a plain `fetch()` between Workers on the same `workers.dev` subdomain fails with Cloudflare `error code: 1042` (see sol-notify's `decision-service-bindings-for-sol-api`).

PR previews add: `SOL_API_KEY_DEV` (sol-api-dev's key), and `MAILCHIMP_SANDBOX_API_KEY` / `MAILCHIMP_SANDBOX_AUDIENCE_ID` (the dedicated sandbox Mailchimp account — Free plan, 250 contacts, double opt-in and automations off; never a client's account), which only the e2e suite (to check members) and `cleanup.yml` (to archive them) use. `GOOGLE_SHEETS_SANDBOX_SERVICE_ACCOUNT` (the sandbox service account's whole JSON key file) / `GOOGLE_SHEETS_SANDBOX_SPREADSHEET_ID` (the sandbox spreadsheet, shared with that account as Editor, with an `E2E` tab) are used the same way — by the suite to read rows back and by `cleanup.yml` to delete them. `API_KEY_STAGING` is reused as the preview Worker's inbound key, as in sol-notify.

Local secrets go in `.dev.vars` (gitignored, see `.dev.vars.example`). Bruno (`bruno/`) has Dev and PR Preview environments — staging and production can't be reached from outside Cloudflare. Each environment's `clientId`, `formId`, `mailchimpIntegrationId` and `sheetsIntegrationId` (and PR Preview's `apiKey`) are **secret** vars, kept in Bruno's local storage and never committed: set them in Bruno (Environments → the env) before sending. For a PR preview they're the sandbox fixtures in `tests/e2e/fixtures.ts`.

## Architecture

**Stack**: Hono 4.x → Cloudflare Workers, no database. Integration config (including Mailchimp API keys and Google service-account keys) and the audit-log trail both live behind `sol-api` (`../sol-api`). Scaffolded from sol-notify — same layout, middleware, logger, response envelope, and release pipeline.

### Source layout

```
src/
├── index.ts                          # Hono app entry; validates ENVIRONMENT on every request
├── routes/
│   ├── health.ts                       # GET /health (no auth)
│   └── integration.ts                  # POST / — perform one integration write, return its outcome
├── validators/integration.ts           # z.discriminatedUnion("type", [mailchimp, google_sheets])
├── services/
│   ├── integration-write.ts            # shared: IntegrationResult, loadIntegration() (skipped/failed), writeAuditLog()
│   ├── mailchimp-integration.ts        # runMailchimpWrite() → outcome; logWriteOutcome() (backgrounded)
│   └── google-sheets-integration.ts    # runGoogleSheetsWrite() → outcome; logGoogleSheetsWriteOutcome() (backgrounded)
├── lib/
│   ├── sol-api.ts                      # getIntegration(), writeNotificationLog() — via the SOL_API binding, text-first parse
│   ├── mailchimp.ts                    # upsertListMember() / mockUpsertListMember(), result links, readable failure reasons
│   ├── google-sheets.ts                # service-account JWT (WebCrypto), buildRow(), appendRow() with read-back dedupe / mockAppendRow()
│   ├── environment.ts                  # ENVIRONMENT enum
│   ├── retry.ts                        # withRetry() with shouldRetry
│   ├── log-context.ts                  # environment, traceId, submissionId on every log line (SOL-46)
│   └── logger.ts                       # structured JSON logger with key/token/secret redaction
├── middleware/{auth,error}.ts          # X-API-Key check (second layer behind the binding), global error envelope
└── types/index.ts                      # Env bindings, AppEnv
tests/
├── unit/                               # Workers pool (vitest.config.ts)
└── e2e/                                # plain Node vs. a deployed preview (vitest.e2e.config.ts); fixtures.ts, helpers/{mailchimp,google-sheets}.ts
scripts/archive-e2e-contacts.mjs        # archives a PR's e2e contacts; run by cleanup.yml on PR close
scripts/delete-e2e-sheet-rows.mjs       # deletes a PR's e2e sheet rows; run by cleanup.yml on PR close
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

Google Sheets (SOL-10) — a sheet's columns are whatever the integration's `column_mapping` says, so `values` is keyed by those column keys (Sol Gate maps form fields onto them):

```json
{
  "clientId": "acme-corp",
  "type": "google_sheets",
  "integrationId": "<uuid>",
  "fields": { "values": { "submitterName": "Jane", "submitterEmail": "jane@example.com" } },
  "context": { "formId": "<uuid>", "submissionId": "…" }
}
```

The row is built in `column_mapping` order; keys it doesn't name are ignored and a column with no value is blank. Two keys are **reserved** and always filled in here, never from `values`: `_timestamp` (write time, ISO 8601) and `_submissionId` (`context.submissionId`). Values are written **RAW** (`valueInputOption=RAW`), so `=IMPORTXML(…)` from a public form is text, not a formula — a change from the old notification service's `USER_ENTERED`. Strings only, ≤ 50,000 chars each (Sheets' cell limit).

Response — **`200` for every outcome**, since a failed write is a valid result, not a broken request:

```json
{ "success": true, "data": { "outcome": "succeeded", "url": "https://us21.admin.mailchimp.com/lists/members/view?id=…", "memberId": "…" } }
{ "success": true, "data": { "outcome": "failed", "url": "https://us21.admin.mailchimp.com/lists/", "detail": "Member In Compliance State: …" } }
{ "success": true, "data": { "outcome": "skipped", "detail": "Integration is not active (status: disabled)" } }
{ "success": true, "data": { "outcome": "succeeded", "url": "https://docs.google.com/spreadsheets/d/…/edit", "range": "'Form submissions'!A12:D12" } }
{ "success": true, "data": { "outcome": "failed", "url": "https://docs.google.com/spreadsheets/d/…/edit", "detail": "The service account …@….iam.gserviceaccount.com can't edit this spreadsheet — share it with that address as an Editor" } }
```

`401` bad key · `422` malformed request · `500` only for something unexpected (or an invalid `ENVIRONMENT`).

- **`skipped`** — the integration can't be used: not found (sol-api scopes the lookup to `clientId`, so another client's integration is "not found" too), wrong type, not `active`, or no Mailchimp / Google Sheets config. The form is misconfigured, not the submission.
- **`failed`** — the write was attempted and didn't succeed, or sol-api couldn't be reached to load the config.
- **`detail`** ends up in a client-facing email: always short and readable, never credentials. The technical error goes to the audit log only.
- **`url`** — Mailchimp: the member's page in Mailchimp's admin UI (from the PUT response's `web_id`), else the account's audiences page. Google Sheets: the spreadsheet (no deep link to the row — that needs the tab's numeric `gid`, an extra request).
- **`memberId`** (Mailchimp) / **`range`** (Sheets) — per-type extras; Sol Gate drops them.

### Request flow

1. Validate the envelope; `type` picks the fields schema.
2. `GET /v1/clients/:clientId/integrations/:integrationId` through `SOL_API` → `skipped` / `failed` if unusable.
3. **Mailchimp:** upsert the member — `PUT /lists/{listId}/members/{md5(email)}`, then tags. Idempotent, so Sol Gate can safely retry the whole call. Up to **2 attempts**, **5 s timeout** per Mailchimp request; permanent 4xx (other than 429) aren't retried.
   **Google Sheets:** sign a service-account JWT (WebCrypto RS256 — `google-auth-library` needs Node APIs Workers lack), exchange it for an access token, then `POST values/{sheet!anchor}:append` (Google's table detection appends after the table's last row, as the old service did). The key may be a PEM or a whole JSON key file. An append is **not** idempotent, so retries are careful — up to **2 attempts**, **5 s timeout** per request:
   - a failure that can't have written anything (getting the token, a 429) is retried;
   - a permanent 4xx (no access, no such spreadsheet/tab, rejected key) isn't;
   - a timeout / 5xx / network error on the append *may have landed*: if the sheet has a `_submissionId` column and the caller sent a `submissionId`, the retry first reads that column back and returns `succeeded` (audit-logged `deduplicated: true`) if the row is there, else appends; **without** a dedupe key it isn't retried — a missing row beats a duplicate. Residual risk: an append Google is still processing when the read-back runs can still be duplicated.
4. Respond with the outcome.
5. In `waitUntil()`: `POST /v1/notification-logs` with `workflow: "integration-service"`, the outcome, and — Mailchimp: `type: "mailchimp"`, `eventName: "mailchimp.upsert_member"`, `{ integrationId, email, tags, memberId?, formId?, submissionId? }`; Sheets: `type: "google_sheets"`, `eventName: "google_sheets.append_row"`, `{ integrationId, range?, deduplicated?, formId?, submissionId? }` (not the row's values — the sheet already has them). Best-effort — logged to console on failure, never re-thrown.

**Time budget:** Sol Gate makes this call inside its own `waitUntil`, which Cloudflare allows ~30 s after its response, and its notifications share that budget. Worst case here is ≈20 s for either type (Mailchimp: 2 attempts × member PUT + tags POST × 5 s; Sheets: token + append, then read-back + append, × 5 s). Whether Sol Gate orchestrates through `waitUntil` or Cloudflare Queues / Workflows is decided in SOL-38.

**Tracing (SOL-46):** Every log line carries `environment`, a `traceId` and, for a submission, a `submissionId`. The `traceId` is the caller's `X-Trace-Id` (Sol Gate's, forwarded) or a new one; the `submissionId` is only ever the caller's `X-Submission-Id`, never made up. `lib/log-context.ts` holds them for the request (AsyncLocalStorage, so `waitUntil` work keeps them) and `lib/sol-api.ts` forwards both to sol-api. There is no `requestId`: Cloudflare's own `$metadata.requestId` tells invocations (e.g. a retried call's attempts) apart. `traceId` is one run of work (on every line); `submissionId` is the form submission it's for (only when there is one). A replayed submission would keep its `submissionId` under a new `traceId`. Filter Workers Logs by `submissionId = <id>` for everything that happened to a submission, `traceId = <id>` for one run, or `environment = production`.

Credentials never leave the service: the logger redacts `*key*`/`*token*` keys, log metadata carries only IDs (plus email and tags for Mailchimp), and `detail` comes from Mailchimp's own problem title/detail or a fixed Sheets reason (which may name the service account's email — not a secret, and what the client needs to share the sheet with).

## Open

- **Staging e2e:** staging is verified end-to-end through Sol Gate staging (SOL-38) once it exists; until then only PR previews exercise real Mailchimp — accepted, since no real users are on this service yet.
- **`web_id` link:** the e2e suite checks the URL uses the member's real `web_id`; one manual click (the suite logs the link) confirms it opens the right member.

### E2E gotchas

- Mailchimp rejects obviously fake domains (`example.com`), so test contacts are real-domain plus-addresses (`e2e+pr<N>-<runId>@solsoftware.co`, override the domain with `E2E_EMAIL_DOMAIN`). Nothing is sent to them. The address format lives in both `tests/e2e/fixtures.ts` (`e2eEmailPrefix`) and `scripts/archive-e2e-contacts.mjs` — keep them in sync.
- Cleanup **archives** (`DELETE /members/{hash}`), never permanently deletes — a permanently deleted address can never be re-added through the API. Archived contacts don't count toward the 250-contact limit, but **active** ones do: each push to an open PR adds one contact until the PR closes, so many long-lived PRs with many pushes could approach 250.
- Archived contacts are hidden from Mailchimp's default contacts view — filter by *Archived* to see them.
- The fixed integration IDs in `tests/e2e/fixtures.ts` must match sol-api's `db/seeds/e2e/sol-integrate.ts`, and so must the Sheets integrations' `column_mapping` (`_timestamp, name, email, _submissionId`) and tab (`E2E`). The `_submissionId` prefix (`e2e-pr<N>-`) lives in both `fixtures.ts` (`e2eSubmissionPrefix`) and `scripts/delete-e2e-sheet-rows.mjs`.
- The sandbox service account needs **Editor** access to the sandbox spreadsheet, and the Sheets API enabled in its GCP project. The "missing spreadsheet" integration points at a made-up ID, so its `failed` detail is "Spreadsheet not found".
- Sheets dedupe-on-retry isn't exercised e2e (it needs Google to time out); it's unit-tested in `tests/unit/lib/google-sheets.test.ts`.
- Inherited from sol-notify (SOL-17): wrangler 3 rejects `--name` with `--env`, so `pr.yml` rewrites `[env.preview]`'s `name = "sol-integrate-preview"` line — keep it exact. Deploying without `--env` would silently bind **production** sol-api. Secrets go in as one `secret bulk` version, and the e2e waits for `/health` to report that run's exact `APP_VERSION`.

## Related

- Sol Gate (SOL-38) — the only caller.
- `sol-api` — `GET /v1/clients/:clientId/integrations/:integrationId` (SOL-7), `POST /v1/notification-logs`.
- sol-notify `form_submission` template (SOL-34) — renders this service's `outcome` / `url` / `detail`.
- SOL-10 — Google Sheets branch (this repo) and Sol Gate's `google_sheets` field mapping. Cutting existing clients over from the old notification service's Sheets step is a separate ticket.
