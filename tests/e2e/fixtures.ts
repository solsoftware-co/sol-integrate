// Seeded into sol-api's `dev` database by sol-api itself
// (db/seeds/e2e/sol-integrate.ts, on every merge to its main, or on demand
// via its "Seed Dev" workflow). Keep these in sync with that seed.
export const CLIENT_ID = "sol";
export const WORKING_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000001";
export const BROKEN_KEY_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000002";
/** Google Sheets (SOL-10): appends to the sandbox spreadsheet's E2E tab. */
export const SHEETS_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000003";
/** Google Sheets, pointed at a spreadsheet ID that doesn't exist — exercises `failed`. */
export const SHEETS_MISSING_SPREADSHEET_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000004";
/** The sandbox spreadsheet's tab the Sheets integrations write to. */
export const SHEETS_TAB = "E2E";
/** Deliberately never seeded — exercises the `skipped` outcome. */
export const MISSING_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000404";

/**
 * Every test contact for a PR starts with this, so cleanup.yml can find and
 * archive them all when the PR closes (scripts/archive-e2e-contacts.mjs —
 * keep the format in sync). The trailing dash keeps PR 1 from matching
 * PR 12. Local runs (no PR number) use `e2e+local-` and clean up after
 * themselves instead.
 */
export function e2eEmailPrefix(prNumber: string | undefined): string {
  return prNumber ? `e2e+pr${prNumber}-` : "e2e+local-";
}

/**
 * The same idea for Google Sheets rows: every row a PR's run appends has a
 * `_submissionId` starting with this, so cleanup.yml can delete them all
 * when the PR closes (scripts/delete-e2e-sheet-rows.mjs — keep in sync).
 */
export function e2eSubmissionPrefix(prNumber: string | undefined): string {
  return prNumber ? `e2e-pr${prNumber}-` : "e2e-local-";
}
