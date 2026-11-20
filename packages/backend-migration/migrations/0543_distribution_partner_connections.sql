-- Migration: 0543_distribution_partner_connections
-- Owner: distribution / VAY-2436
--
-- Partner apps (Creator Links first) and a hotel's one-time approval of one, the OAuth 2.0
-- authorization code flow with PKCE behind /partner (contract "What Vayada accepts and sends").
--
-- A partner app is a row of distribution.external_api_clients with the new 'partner_connection'
-- surface: its client secret's SHA-256 in credential_hash_ref, its exact return addresses, the
-- scopes it may ask for and its webhook address (the webhook signing secret comes with the
-- delivery, VAY-2438). A hotel's approval is a partner_connections row: one active row per app and
-- property. Authorization codes and tokens are stored only as SHA-256 hashes of random values.
-- Codes and tokens die with their connection; a disconnect revokes them all.
--
-- New product tables: the API login gets its DML from the default privileges (no GRANT here).

SET LOCAL lock_timeout = '5s';

ALTER TABLE distribution.external_api_clients
  DROP CONSTRAINT chk_distribution_external_api_clients_surfaces,
  ADD CONSTRAINT chk_distribution_external_api_clients_surfaces
    CHECK (
      allowed_surfaces <@ ARRAY[
        'public_profile', 'public_quote', 'deep_link',
        'partner_feed', 'mcp_tool', 'partner_connection'
      ]::TEXT[]
    ),
  ADD COLUMN redirect_uris  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN allowed_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN webhook_url    TEXT,
  ADD CONSTRAINT chk_distribution_external_api_clients_partner_scopes
    CHECK (allowed_scopes <@ ARRAY['promo_codes', 'bookings']::TEXT[]),
  -- A partner app can be approved only with a secret, a return address and a scope.
  ADD CONSTRAINT chk_distribution_external_api_clients_partner_connection
    CHECK (
      NOT ('partner_connection' = ANY(allowed_surfaces))
      OR (
        credential_hash_ref IS NOT NULL
        AND credential_hash_ref ~ '^sha256:[0-9a-f]{64}$'
        AND cardinality(redirect_uris) > 0
        AND array_position(redirect_uris, NULL) IS NULL
        AND cardinality(allowed_scopes) > 0
      )
    );

CREATE TABLE distribution.partner_connections (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID        NOT NULL
                         REFERENCES distribution.external_api_clients(id) ON DELETE RESTRICT,
  property_id          UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  scopes               TEXT[]      NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  approved_by_user_id  UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by_user_id   UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  revoked_at           TIMESTAMPTZ,
  revocation_reason    TEXT        CHECK (revocation_reason IN ('hotel_disconnected', 'partner_revoked')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_distribution_partner_connections_scopes
    CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['promo_codes', 'bookings']::TEXT[]),
  CONSTRAINT chk_distribution_partner_connections_revocation
    CHECK (
      (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
      OR (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL
          AND revocation_reason IS NULL)
    )
);

CREATE UNIQUE INDEX uq_distribution_partner_connections_active
  ON distribution.partner_connections (client_id, property_id)
  WHERE status = 'active';

CREATE INDEX idx_distribution_partner_connections_property
  ON distribution.partner_connections (property_id, status);

-- Single use, minutes long, bound to the return address and the PKCE challenge it was issued for.
-- token_family_id is set when the code is swapped, so a second use can stop what the first got.
CREATE TABLE distribution.partner_authorization_codes (
  code_hash        TEXT        PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  connection_id    UUID        NOT NULL
                     REFERENCES distribution.partner_connections(id) ON DELETE CASCADE,
  redirect_uri     TEXT        NOT NULL,
  code_challenge   TEXT        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes           TEXT[]      NOT NULL
                     CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['promo_codes', 'bookings']::TEXT[]),
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  token_family_id  UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_distribution_partner_authorization_codes_use
    CHECK ((used_at IS NULL) = (token_family_id IS NULL))
);

CREATE INDEX idx_distribution_partner_authorization_codes_connection
  ON distribution.partner_authorization_codes (connection_id);

-- Access tokens last an hour; each refresh token is swapped once for a new pair in the same family.
CREATE TABLE distribution.partner_tokens (
  token_hash     TEXT        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  connection_id  UUID        NOT NULL
                   REFERENCES distribution.partner_connections(id) ON DELETE CASCADE,
  token_kind     TEXT        NOT NULL CHECK (token_kind IN ('access', 'refresh')),
  family_id      UUID        NOT NULL,
  scopes         TEXT[]      NOT NULL
                   CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['promo_codes', 'bookings']::TEXT[]),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_distribution_partner_tokens_use
    CHECK (token_kind = 'refresh' OR used_at IS NULL)
);

CREATE INDEX idx_distribution_partner_tokens_connection
  ON distribution.partner_tokens (connection_id);

CREATE INDEX idx_distribution_partner_tokens_family
  ON distribution.partner_tokens (family_id);
