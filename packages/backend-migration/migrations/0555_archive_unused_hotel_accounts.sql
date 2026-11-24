-- Migration: 0555_archive_unused_hotel_accounts
-- Owner: identity, hotel-catalog / VAY-2602. Held by hand: released with Flamur's yes (decisions
-- 105-109, and Depadma on 2026-11-24) after the before-counts in the PR.
--
-- Archives the hotel accounts Flamur approved on the VAY-2602 list and retires their hotels, so they
-- leave Vayada Admin and nobody signs in to them again. Nothing is deleted: memberships, links,
-- bookings, payments, Stripe accounts and audit rows stay, and staff can restore a hotel. Accounts are
-- matched by id, never by name:
-- * 22 named on the list by their WorkOS organisation: 17 sign-ups never used again, 4 old Vayada
--   tests (two of them with test bookings, one with a Stripe test account that stays untouched) and
--   Timo's Depadma account;
-- * the 70 August leftovers: active hotel accounts created in August 2026 whose WorkOS organisation
--   is none of the 43 that WorkOS Production held on 2026-11-24 (59 release smoke hotels and 11 early
--   test sign-ups; nobody can sign in to them).
-- Every other account stays, among them the 14 kept accounts and one outside sign-up. The
-- WorkOS organisations and users are removed by hand afterwards (VAY-2602 step c), not here.
-- A named account archived before this runs (a WorkOS deletion archives it) is fine: its hotels are
-- still retired. Leftovers may only have become fewer. Any other surprise stops the migration, and with
-- it the next-api start (the running task keeps serving): read its failure reason, then decide.
-- Rollback: any image; this changes only statuses that every image already reads.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMPORARY TABLE vay2602_named (workos_org_id TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO vay2602_named (workos_org_id) VALUES
  ('org_01KZ15CS16ZTJ3B8NKWFNNZ04A'), ('org_01KZ9D0RJZW05H8JFA3C72Q6ZT'), ('org_01KZ9D1BM6DPM0967CY6H61S4E'),
  ('org_01KZ9G9EDS1WF1VP5HN9GAC00T'), ('org_01KZB2QVF4S8CTQYKP9VR1E7JJ'), ('org_01KZR21HWKHVH4AEHH9R9C43S1'),
  ('org_01KZY0NRS02AWVW0MHPVRYEBMK'), ('org_01M0VMK95VEHRWT93QGG1ADX7X'), ('org_01M0VSN2C297BZRE9KBJ32YJCM'),
  ('org_01M18DDHE49CX9B1VYV57Z0VA0'), ('org_01M18N6QVSYM6JBXECP1S843A9'), ('org_01M1R50D1NXW3C2T2VZBNPQB77'),
  ('org_01M1T7YCNDSPFY8HDZMXM83D9T'), ('org_01M45FDVM6RBJ3YDR82F4ZQP08'), ('org_01M4BDA0G69A23QZ7EV6G2PTAQ'),
  ('org_01M4BDCP8QA3YX7C121F9CNSPS'), ('org_01M4H88YWW1F1W1TCYSRHGY3ND'),
  -- The 4 old Vayada tests (decision 106).
  ('org_01KZQPR9FWP6Q4WAKQR8D0MN52'), ('org_01KZY2QXGPX8PPDXZAHWG0ATBA'), ('org_01KZY9HV858JJS6NG89Y1HC3HW'),
  ('org_01M5EYG361MJS6T0AQH4RA64XN'),
  -- Timo's Depadma account (Flamur, 2026-11-24).
  ('org_01M6Q2VNAACPQADPC4F6V85WFB');

-- The 43 organisations WorkOS Production held on 2026-11-24.
CREATE TEMPORARY TABLE vay2602_workos (workos_org_id TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO vay2602_workos (workos_org_id) VALUES
  ('org_01KWKGK4C57N3RM7KKWD1CNP5Y'), ('org_01KWM128WTAB6EZ8ESR5MAZHQR'), ('org_01KWP4YXM0HW1YM0HWBH7EXBFS'),
  ('org_01KYCW25C5ZCH1Q1ZARTSPN5MY'), ('org_01KZ15CS16ZTJ3B8NKWFNNZ04A'), ('org_01KZ9D0RJZW05H8JFA3C72Q6ZT'),
  ('org_01KZ9D1BM6DPM0967CY6H61S4E'), ('org_01KZ9G9EDS1WF1VP5HN9GAC00T'), ('org_01KZB2QVF4S8CTQYKP9VR1E7JJ'),
  ('org_01KZQPR9FWP6Q4WAKQR8D0MN52'), ('org_01KZQQ019EF052PFARPCG7B613'), ('org_01KZR21HWKHVH4AEHH9R9C43S1'),
  ('org_01KZS29B4KATWDE5C3ENNHPHHW'), ('org_01KZY0NRS02AWVW0MHPVRYEBMK'), ('org_01KZY2QXGPX8PPDXZAHWG0ATBA'),
  ('org_01KZY9HV858JJS6NG89Y1HC3HW'), ('org_01KZZX0PEATYHQ7Y3RVYBYQHW9'), ('org_01M0DE7SDFK15GWS12Y5FVQASV'),
  ('org_01M0VMK95VEHRWT93QGG1ADX7X'), ('org_01M0VSN2C297BZRE9KBJ32YJCM'), ('org_01M0YF1WF2TNNA6MMX2ZBYHMSY'),
  ('org_01M18DDHE49CX9B1VYV57Z0VA0'), ('org_01M18N6QVSYM6JBXECP1S843A9'), ('org_01M1R50D1NXW3C2T2VZBNPQB77'),
  ('org_01M1RC66GQZ5M9ZW08DW6RGXDG'), ('org_01M1T7YCNDSPFY8HDZMXM83D9T'), ('org_01M25S110V1M5DC5FKNCRMNW8S'),
  ('org_01M3MFJHD9BHRWZ36P6CNDVNXJ'), ('org_01M3WJKDJ5W95HW45PJRSW92P9'), ('org_01M45FDVM6RBJ3YDR82F4ZQP08'),
  ('org_01M4BDA0G69A23QZ7EV6G2PTAQ'), ('org_01M4BDCP8QA3YX7C121F9CNSPS'), ('org_01M4DNF2Y3SNXXHXBWCDQCY6G3'),
  ('org_01M4H88YWW1F1W1TCYSRHGY3ND'), ('org_01M4PE6WC4NWGKPD5D3DMY0JZE'), ('org_01M5EYG361MJS6T0AQH4RA64XN'),
  ('org_01M6A4QD7K1NKNMZGTQ7AB09A9'), ('org_01M6A933D9RY1PYH4ZD7XA58K1'), ('org_01M6DGVQAEHW5PVH2QH6DABVAJ'),
  ('org_01M6DPQ3Z4QVWSRRMPR89DD3G8'), ('org_01M6FD0RH0EQGD68ATXHWD50MR'), ('org_01M6Q2VNAACPQADPC4F6V85WFB'),
  ('org_01M82TD8G3J0C9A03B0BCWADZX');

-- Only production holds the listed accounts. Any other database (tests, local, staging) has none of
-- them, and there the approved set stays empty, so nothing changes.
CREATE TEMPORARY TABLE vay2602_production ON COMMIT DROP AS
  SELECT EXISTS (SELECT 1 FROM identity.organizations listed
                 WHERE listed.workos_org_id IN (SELECT workos_org_id FROM vay2602_named)) AS present;

-- The approved accounts: the named ones, active or already archived, and the leftovers still active.
CREATE TEMPORARY TABLE vay2602_accounts ON COMMIT DROP AS
  SELECT account.id, account.workos_org_id, account.status,
         account.workos_org_id IN (SELECT workos_org_id FROM vay2602_named) AS named
  FROM identity.organizations account
  WHERE account.kind = 'hotel_group'
    AND (SELECT present FROM vay2602_production)
    AND ((account.workos_org_id IN (SELECT workos_org_id FROM vay2602_named)
          AND account.status IN ('active', 'archived'))
         OR (account.status = 'active'
             AND account.workos_org_id NOT IN (SELECT workos_org_id FROM vay2602_workos)
             AND account.created_at >= '2026-08-01T00:00:00Z'
             AND account.created_at < '2026-09-01T00:00:00Z'));

-- Their hotels: every property an approved account holds through an active link.
CREATE TEMPORARY TABLE vay2602_properties ON COMMIT DROP AS
  SELECT DISTINCT property.id
  FROM hotel_catalog.properties property
  JOIN identity.organization_resource_links link
    ON link.resource_id = property.id::text AND link.status = 'active'
   AND (link.product, link.resource_type) IN (('hotel_catalog', 'property'), ('pms', 'pms_property'))
  WHERE link.organization_id IN (SELECT id FROM vay2602_accounts);

-- Flamur's Vayada staff login retires the hotels, as when staff retire one in Vayada Admin.
CREATE TEMPORARY TABLE vay2602_staff ON COMMIT DROP AS
  SELECT external.user_id AS id
  FROM identity.external_identities external
  JOIN identity.users person ON person.id = external.user_id AND person.status = 'active'
  WHERE external.provider = 'workos' AND external.provider_user_id = 'user_01KZQPZ02TKJJF9TPTBXG3NXPP'
    AND EXISTS (SELECT 1 FROM identity.organization_memberships membership
                JOIN identity.organizations platform
                  ON platform.id = membership.organization_id
                 AND platform.kind = 'platform' AND platform.status = 'active'
                WHERE membership.user_id = external.user_id AND membership.status = 'active');

-- Gates: stop before anything changes. The approved set must be the list, and nothing that still needs
-- an account may be in it: the VAY-2493 hotel deletion's blockers, with upcoming stays counted from
-- the day before today in UTC, so a hotel west of UTC is covered too.
DO $$
BEGIN
  IF NOT (SELECT present FROM vay2602_production) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM vay2602_accounts WHERE named) <> 22 THEN
    RAISE EXCEPTION 'VAY-2602: a named account is not an active or archived hotel account';
  END IF;
  IF (SELECT count(*) FROM vay2602_accounts WHERE NOT named) > 70 THEN
    RAISE EXCEPTION 'VAY-2602: more than the 70 August leftovers match';
  END IF;
  IF (SELECT count(*) FROM vay2602_staff) <> 1 THEN
    RAISE EXCEPTION 'VAY-2602: the Vayada staff login is not one active platform member';
  END IF;
  IF EXISTS (SELECT 1 FROM identity.organization_resource_links link
             JOIN identity.organizations account
               ON account.id = link.organization_id
              AND account.kind = 'hotel_group' AND account.status <> 'archived'
             WHERE link.resource_id IN (SELECT id::text FROM vay2602_properties)
               AND link.status = 'active'
               AND (link.product, link.resource_type) IN (('hotel_catalog', 'property'), ('pms', 'pms_property'))
               AND link.organization_id NOT IN (SELECT id FROM vay2602_accounts)) THEN
    RAISE EXCEPTION 'VAY-2602: a hotel is shared with an account that stays';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.guest_bookings booking
             WHERE booking.property_id IN (SELECT id FROM vay2602_properties)
               AND booking.lifecycle_status IN ('pending_payment', 'confirmed')
               AND booking.check_out >= (now() AT TIME ZONE 'UTC')::date - 1) THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has an upcoming booking';
  END IF;
  IF EXISTS (SELECT 1 FROM pms.channel_connections connection
             WHERE connection.property_id IN (SELECT id FROM vay2602_properties)
               AND connection.connection_status IN ('connected', 'degraded')) THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has a connected channel';
  END IF;
  IF EXISTS (SELECT 1 FROM finance.payments payment
             WHERE payment.property_id IN (SELECT id FROM vay2602_properties)
               AND payment.status IN ('requires_action', 'authorized', 'pending', 'disputed'))
     OR EXISTS (SELECT 1 FROM finance.card_refund_commands refund
                WHERE refund.property_id IN (SELECT id FROM vay2602_properties)
                  AND refund.status = 'pending') THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has an unresolved payment';
  END IF;
  IF EXISTS (SELECT 1 FROM finance.payouts payout
             WHERE (payout.property_id IN (SELECT id FROM vay2602_properties)
                    OR payout.related_property_id IN (SELECT id FROM vay2602_properties))
               AND payout.payout_status IN ('pending', 'scheduled', 'processing', 'failed'))
     OR EXISTS (SELECT 1 FROM finance.hotel_payouts hotel_payout
                WHERE hotel_payout.property_id IN (SELECT id FROM vay2602_properties)
                  AND hotel_payout.livemode AND hotel_payout.sent_at IS NULL
                  AND hotel_payout.returned_at IS NULL)
     OR EXISTS (SELECT 1 FROM finance.hotel_payout_ledger ledger
                WHERE ledger.property_id IN (SELECT id FROM vay2602_properties) AND ledger.livemode) THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has an open payout or live payout money';
  END IF;
  -- A custom domain also needs its Cloudflare hostname removed: that stays a person's job.
  IF EXISTS (SELECT 1 FROM hotel_catalog.property_domains domain
             WHERE domain.property_id IN (SELECT id FROM vay2602_properties)) THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has a custom domain';
  END IF;
  IF EXISTS (SELECT 1 FROM distribution.partner_connections connection
             WHERE connection.property_id IN (SELECT id FROM vay2602_properties)
               AND connection.status = 'active') THEN
    RAISE EXCEPTION 'VAY-2602: a hotel has an active partner connection';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.account_booking_pages page
             WHERE page.organization_id IN (SELECT id FROM vay2602_accounts) AND page.live) THEN
    RAISE EXCEPTION 'VAY-2602: an account booking page is live';
  END IF;
  -- Only Codexqa's Stripe test account is expected; it stays as it is (decision 106).
  IF EXISTS (SELECT 1 FROM finance.payment_provider_accounts provider
             JOIN vay2602_accounts account ON account.workos_org_id <> 'org_01KZY9HV858JJS6NG89Y1HC3HW'
             WHERE provider.provider = 'stripe' AND provider.provider_account_id IS NOT NULL
               AND (provider.organization_id = account.id
                    OR provider.property_id IN (
                      SELECT property.id FROM vay2602_properties property
                      JOIN identity.organization_resource_links link
                        ON link.resource_id = property.id::text AND link.organization_id = account.id
                       AND link.status = 'active'))) THEN
    RAISE EXCEPTION 'VAY-2602: an approved account has a Stripe account';
  END IF;
END $$;

-- The hotels: retired, as staff retirement does (VAY-1280), with one audit row each.
WITH retired AS (
  UPDATE hotel_catalog.properties
  SET lifecycle_status = 'retired',
      lifecycle_revision = lifecycle_revision + 1,
      pre_hold_profile_status = COALESCE(pre_hold_profile_status, profile_status),
      profile_status = 'disabled',
      retired_at = now(),
      retired_by_user_id = (SELECT id FROM vay2602_staff),
      updated_at = now()
  WHERE id IN (SELECT id FROM vay2602_properties) AND lifecycle_status <> 'retired'
  RETURNING id, lifecycle_revision
)
INSERT INTO platform.product_audit_events (
  audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type, actor_user_id,
  target_resource_product, target_resource_type, target_resource_id, correlation_id,
  redacted_payload, private_payload, audit_metadata, privacy_scope
)
SELECT 'vay2602-0555:property:' || retired.id::text, 'hotel_catalog', 'platform.property.lifecycle.retire',
       now(), 'property', retired.id, 'migration', (SELECT id FROM vay2602_staff),
       'hotel_catalog', 'property', retired.id::text, 'VAY-2602',
       jsonb_build_object('status', 'retired', 'revision', retired.lifecycle_revision),
       jsonb_build_object('reason', 'VAY-2602: hotel of an unused account, archived by migration 0555'),
       jsonb_build_object('migration', '0555', 'decisions', '105-109'),
       'confidential'
FROM retired;

-- Their public booking pages: off, as staff retirement does.
UPDATE distribution.public_hotel_bookability_profiles
SET profile_status = 'unavailable', freshness_status = 'unavailable', updated_at = now()
WHERE property_id IN (SELECT id FROM vay2602_properties)
  AND (profile_status <> 'unavailable' OR freshness_status <> 'unavailable');
DELETE FROM distribution.active_public_booking_revision
WHERE property_id IN (SELECT id FROM vay2602_properties);

-- The accounts still active: archived, which ends sign-in and hides them in Vayada Admin, with one
-- audit row each.
WITH archived AS (
  UPDATE identity.organizations
  SET status = 'archived', updated_at = now()
  WHERE id IN (SELECT id FROM vay2602_accounts) AND status = 'active'
  RETURNING id
)
INSERT INTO platform.product_audit_events (
  audit_key, product, action, occurred_at, tenant_scope, organization_id, actor_type, actor_user_id,
  target_resource_product, target_resource_type, target_resource_id, correlation_id,
  redacted_payload, private_payload, audit_metadata, privacy_scope
)
SELECT 'vay2602-0555:account:' || archived.id::text, 'identity', 'identity.organization.archive',
       now(), 'organization', archived.id, 'migration', (SELECT id FROM vay2602_staff),
       'identity', 'organization', archived.id::text, 'VAY-2602',
       jsonb_build_object('status', 'archived'),
       jsonb_build_object('reason', 'VAY-2602: unused hotel account, archived by migration 0555'),
       jsonb_build_object('migration', '0555', 'decisions', '105-109'),
       'confidential'
FROM archived;
