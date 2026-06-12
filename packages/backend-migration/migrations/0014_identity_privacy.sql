-- Migration: 0014_identity_privacy
-- Owner: domain-identity
-- See: engineering/marketplace-route-migration-inventory.md,
--      engineering/workos-identity-architecture.md
--
-- Moves cookie consent, consent history, and GDPR request state behind
-- identity-owned surfaces. Legacy marketplace tables remain migration inputs
-- until the privacy route cutover is complete.

CREATE TABLE identity.user_consent_status (
  user_id              UUID         PRIMARY KEY REFERENCES identity.users(id),
  terms_accepted_at    TIMESTAMPTZ,
  terms_version        TEXT,
  privacy_accepted_at  TIMESTAMPTZ,
  privacy_version      TEXT,
  marketing_consent    BOOLEAN      NOT NULL DEFAULT FALSE,
  marketing_consent_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE identity.cookie_consents (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  TEXT         NOT NULL,
  user_id     UUID         REFERENCES identity.users(id) ON DELETE SET NULL,
  necessary   BOOLEAN      NOT NULL DEFAULT TRUE,
  functional  BOOLEAN      NOT NULL DEFAULT FALSE,
  analytics   BOOLEAN      NOT NULL DEFAULT FALSE,
  marketing   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_cookie_consents_visitor UNIQUE (visitor_id)
);

CREATE INDEX idx_cookie_consents_user_id
  ON identity.cookie_consents(user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE identity.consent_history (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         REFERENCES identity.users(id) ON DELETE SET NULL,
  visitor_id     TEXT,
  consent_type   TEXT         NOT NULL
                              CHECK (consent_type IN (
                                'terms', 'privacy', 'marketing', 'cookies',
                                'deletion_request', 'deletion_cancelled'
                              )),
  consent_given  BOOLEAN      NOT NULL,
  version        TEXT,
  metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_consent_history_user_created
  ON identity.consent_history(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE identity.gdpr_requests (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  request_type   TEXT         NOT NULL CHECK (request_type IN ('export', 'deletion')),
  status         TEXT         NOT NULL CHECK (status IN (
                               'pending', 'processing', 'completed', 'cancelled', 'expired'
                             )),
  download_token TEXT,
  requested_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  ip_address     TEXT,
  metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_gdpr_requests_user_type_requested
  ON identity.gdpr_requests(user_id, request_type, requested_at DESC);

CREATE UNIQUE INDEX uq_gdpr_requests_download_token
  ON identity.gdpr_requests(download_token)
  WHERE download_token IS NOT NULL;

-- Backfill from the legacy auth-db privacy tables when this migration is run
-- against a database that still has them. Target-schema-only test databases do
-- not have public.users/cookie_consent/consent_history/gdpr_requests, so each
-- copy is guarded and becomes a no-op when the source table is absent.
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND column_name = 'terms_accepted_at'
     ) THEN
    EXECUTE $backfill_user_consent$
      INSERT INTO identity.user_consent_status (
        user_id,
        terms_accepted_at,
        terms_version,
        privacy_accepted_at,
        privacy_version,
        marketing_consent,
        marketing_consent_at,
        created_at,
        updated_at
      )
      SELECT
        users.id,
        users.terms_accepted_at,
        users.terms_version,
        users.privacy_accepted_at,
        users.privacy_version,
        COALESCE(users.marketing_consent, FALSE),
        users.marketing_consent_at,
        COALESCE(users.created_at, now()),
        COALESCE(users.updated_at, now())
      FROM public.users AS users
      JOIN identity.users AS identity_users
        ON identity_users.id = users.id
      WHERE users.terms_accepted_at IS NOT NULL
         OR users.privacy_accepted_at IS NOT NULL
         OR users.marketing_consent IS NOT NULL
         OR users.marketing_consent_at IS NOT NULL
      ON CONFLICT (user_id) DO UPDATE SET
        terms_accepted_at = EXCLUDED.terms_accepted_at,
        terms_version = EXCLUDED.terms_version,
        privacy_accepted_at = EXCLUDED.privacy_accepted_at,
        privacy_version = EXCLUDED.privacy_version,
        marketing_consent = EXCLUDED.marketing_consent,
        marketing_consent_at = EXCLUDED.marketing_consent_at,
        updated_at = now()
    $backfill_user_consent$;
  END IF;

  IF to_regclass('public.cookie_consent') IS NOT NULL THEN
    EXECUTE $backfill_cookie_consent$
      INSERT INTO identity.cookie_consents (
        id,
        visitor_id,
        user_id,
        necessary,
        functional,
        analytics,
        marketing,
        created_at,
        updated_at
      )
      SELECT
        legacy.id,
        legacy.visitor_id,
        identity_users.id,
        legacy.necessary,
        legacy.functional,
        legacy.analytics,
        legacy.marketing,
        legacy.created_at,
        legacy.updated_at
      FROM (
        SELECT DISTINCT ON (visitor_id) *
        FROM public.cookie_consent
        ORDER BY visitor_id, updated_at DESC, created_at DESC
      ) AS legacy
      LEFT JOIN identity.users AS identity_users
        ON identity_users.id = legacy.user_id
      ON CONFLICT (visitor_id) DO UPDATE SET
        user_id = COALESCE(EXCLUDED.user_id, identity.cookie_consents.user_id),
        necessary = EXCLUDED.necessary,
        functional = EXCLUDED.functional,
        analytics = EXCLUDED.analytics,
        marketing = EXCLUDED.marketing,
        updated_at = EXCLUDED.updated_at
    $backfill_cookie_consent$;
  END IF;

  IF to_regclass('public.consent_history') IS NOT NULL THEN
    EXECUTE $backfill_consent_history$
      INSERT INTO identity.consent_history (
        id,
        user_id,
        consent_type,
        consent_given,
        version,
        metadata,
        created_at
      )
      SELECT
        legacy.id,
        identity_users.id,
        legacy.consent_type,
        legacy.consent_given,
        legacy.version,
        jsonb_strip_nulls(jsonb_build_object(
          'ipAddress', legacy.ip_address,
          'userAgent', legacy.user_agent
        )),
        legacy.created_at
      FROM public.consent_history AS legacy
      LEFT JOIN identity.users AS identity_users
        ON identity_users.id = legacy.user_id
      WHERE legacy.consent_type IN (
        'terms', 'privacy', 'marketing', 'cookies',
        'deletion_request', 'deletion_cancelled'
      )
      ON CONFLICT (id) DO NOTHING
    $backfill_consent_history$;
  END IF;

  IF to_regclass('public.gdpr_requests') IS NOT NULL THEN
    EXECUTE $backfill_gdpr_requests$
      INSERT INTO identity.gdpr_requests (
        id,
        user_id,
        request_type,
        status,
        download_token,
        requested_at,
        processed_at,
        expires_at,
        ip_address,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        legacy.id,
        identity_users.id,
        legacy.request_type,
        legacy.status,
        legacy.download_token,
        legacy.requested_at,
        legacy.processed_at,
        legacy.expires_at,
        legacy.ip_address,
        jsonb_strip_nulls(jsonb_build_object(
          'cancellationReason', legacy.cancellation_reason
        )),
        legacy.requested_at,
        COALESCE(legacy.processed_at, legacy.requested_at)
      FROM public.gdpr_requests AS legacy
      JOIN identity.users AS identity_users
        ON identity_users.id = legacy.user_id
      WHERE legacy.request_type IN ('export', 'deletion')
        AND legacy.status IN ('pending', 'processing', 'completed', 'cancelled', 'expired')
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        download_token = EXCLUDED.download_token,
        processed_at = EXCLUDED.processed_at,
        expires_at = EXCLUDED.expires_at,
        ip_address = EXCLUDED.ip_address,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    $backfill_gdpr_requests$;
  END IF;
END $$;
