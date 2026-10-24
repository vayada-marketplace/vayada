-- Migration: 0511_hotel_account_agreement_acceptances
-- Owner: domain-hotels (hotel account agreements)
-- See: VAY-2246 (packages/domain-hotels/src/hotelAccountAgreements.ts, vayada.com/terms/dpa)
--
-- Each hotel account accepts the hotel terms together with their annex, the data processing agreement
-- (GDPR Art. 28): at sign-up, or later through its account admin. One row per account and pair of
-- versions records who accepted, when and where; the first acceptance of a pair stays, and a new version
-- adds a row. Additive: nothing existing changes, and no data is copied.
SET LOCAL lock_timeout = '5s';

CREATE TABLE hotel_catalog.account_agreement_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  terms_version TEXT NOT NULL CHECK (terms_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  dpa_version TEXT NOT NULL CHECK (dpa_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('signup', 'account_admin')),
  UNIQUE (organization_id, terms_version, dpa_version)
);

COMMENT ON TABLE hotel_catalog.account_agreement_acceptances IS
  'VAY-2246: a hotel account''s acceptance of the hotel terms and the data processing agreement, by version.';
