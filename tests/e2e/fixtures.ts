// Seeded into sol-api's `dev` database by scripts/seed-dev-e2e.sql, which
// pr.yml runs before every e2e run. Keep these in sync with that script.
export const CLIENT_ID = "sol";
export const WORKING_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000001";
export const BROKEN_KEY_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000002";
/** Deliberately never seeded — exercises the `skipped` outcome. */
export const MISSING_INTEGRATION_ID = "e2e00000-0000-4000-8000-000000000404";
