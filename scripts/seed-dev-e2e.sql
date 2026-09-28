-- One-time setup: creates the two sandbox Mailchimp integrations the e2e
-- suite (tests/e2e/) runs against, in sol-api's persistent `dev` database
-- (SOL-31). Not run by CI — seeding the database isn't the e2e runner's job.
--
-- To run: paste into the Neon console's SQL editor on the `dev` branch of
-- the sol-api project, replace the two placeholders in `sandbox` below, and
-- run it. Don't commit the filled-in copy.
--
-- Safe to re-run (it upserts). Re-run it after sol-api's
-- `npm run db:branch:reset`, which resets dev from staging and wipes these
-- rows — the suite's first write test fails with a pointer back here if
-- they're missing.
--
-- Both integrations point at the dedicated sandbox Mailchimp account — never
-- a client's. IDs are fixed so the suite can reference them directly
-- (tests/e2e/fixtures.ts).

WITH sandbox AS (
  SELECT
    'PASTE_SANDBOX_MAILCHIMP_API_KEY'::text AS api_key,   -- ends in -usXX
    'PASTE_SANDBOX_AUDIENCE_ID'::text AS audience_id
),
base AS (
  -- Client `sol` (Sol Software) already exists in dev; integrations.client_id
  -- is a foreign key to it.
  INSERT INTO integrations (id, client_id, type, name, description, status)
  VALUES
    ('e2e00000-0000-4000-8000-000000000001', 'sol', 'mailchimp', 'E2E sandbox',
     'sol-integrate e2e (SOL-20): sandbox Mailchimp account, working key', 'active'),
    ('e2e00000-0000-4000-8000-000000000002', 'sol', 'mailchimp', 'E2E sandbox (broken key)',
     'sol-integrate e2e (SOL-20): deliberately invalid key, exercises the failed outcome', 'active')
  ON CONFLICT (id) DO UPDATE SET
    client_id = EXCLUDED.client_id,
    type = EXCLUDED.type,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    updated_at = now()
  RETURNING id
)
-- Server prefix is the key's `-usXX` suffix. The broken key keeps the real
-- prefix so the request reaches the right datacenter and Mailchimp answers
-- with a real 401, rather than failing on DNS.
INSERT INTO mailchimp_integrations (integration_id, api_key, list_id, server_prefix)
SELECT base.id,
       CASE WHEN base.id = 'e2e00000-0000-4000-8000-000000000001'
            THEN sandbox.api_key
            ELSE '00000000000000000000000000000000-' || split_part(sandbox.api_key, '-', 2)
       END,
       sandbox.audience_id,
       split_part(sandbox.api_key, '-', 2)
FROM base CROSS JOIN sandbox
ON CONFLICT (integration_id) DO UPDATE SET
  api_key = EXCLUDED.api_key,
  list_id = EXCLUDED.list_id,
  server_prefix = EXCLUDED.server_prefix;
