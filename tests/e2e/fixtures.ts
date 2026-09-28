// Seeded into sol-api's `dev` database by scripts/seed-dev-e2e.sql, which
// pr.yml runs before every e2e run. Keep these in sync with that script.
export const CLIENT_ID = "sol";
export const WORKING_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000001";
export const BROKEN_KEY_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000002";
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
