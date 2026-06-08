-- Migration: 0009_distribution
-- Owner: domain-distribution
-- See: engineering/public-bookability-contract.md,
--      engineering/target-schema-migration-coverage.md,
--      engineering/target-schema-ownership-map.md
--
-- Creates the distribution target schema for public-safe hotel bookability
-- profiles, room offer snapshots, quote read models, checkout deep-link
-- context, and external public API client usage state.
--
-- Legacy Booking/PMS/Finance databases are migration/parity inputs only.
-- Runtime TypeScript code must not use this migration as a reason to read
-- legacy product databases directly.

CREATE SCHEMA IF NOT EXISTS distribution;

ALTER TABLE booking.checkout_contexts
  ADD CONSTRAINT uq_booking_checkout_contexts_id_property_quote
  UNIQUE (id, property_id, quote_session_id);

CREATE FUNCTION distribution.jsonb_has_forbidden_public_key(
  document JSONB,
  forbidden_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  WITH RECURSIVE json_walk(value) AS (
    SELECT document
    UNION ALL
    SELECT child.value
    FROM json_walk
    CROSS JOIN LATERAL (
      SELECT object_child.value
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(json_walk.value) = 'object'
          THEN json_walk.value
          ELSE '{}'::jsonb
        END
      ) AS object_child(key, value)
      UNION ALL
      SELECT array_child.value
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(json_walk.value) = 'array'
          THEN json_walk.value
          ELSE '[]'::jsonb
        END
      ) AS array_child(value)
    ) AS child(value)
  )
  SELECT EXISTS (
    SELECT 1
    FROM json_walk
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE
        WHEN jsonb_typeof(json_walk.value) = 'object'
        THEN json_walk.value
        ELSE '{}'::jsonb
      END
    ) AS object_keys(key)
    WHERE EXISTS (
      SELECT 1
      FROM unnest(forbidden_keys) AS forbidden(forbidden_key)
      WHERE lower(regexp_replace(object_keys.key, '[^a-zA-Z0-9]', '', 'g')) =
            lower(regexp_replace(forbidden.forbidden_key, '[^a-zA-Z0-9]', '', 'g'))
    )
  );
$$;

CREATE FUNCTION distribution.jsonb_has_distribution_private_key(document JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT distribution.jsonb_has_forbidden_public_key(
    document,
    ARRAY[
      'access_token', 'api_key', 'arrival_time', 'assignment_id',
      'bank_account', 'body', 'channel_connection_id',
      'channel_credentials', 'channex_booking_id', 'channex_channel_id',
      'channex_property_id', 'channex_rate_plan_id',
      'channex_room_type_id', 'chat_messages', 'client_secret',
      'commission_rate', 'commission_rule_id', 'email', 'external_channel_id',
      'external_rate_plan_id', 'external_room_type_id', 'first_name',
      'guest_email', 'guest_input', 'guest_name', 'guest_phone',
      'housekeeping', 'ip_address', 'last_name', 'legacy_table',
      'maintenance', 'message_body', 'messages', 'owner_note',
      'phone', 'private_notes', 'processor_fee_breakdown',
      'provider_account_id', 'provider_payment_intent_id',
      'provider_transaction_id', 'raw_body', 'raw_headers',
      'raw_payload', 'raw_secret', 'request_body', 'response_body',
      'risk_review', 'room_id', 'room_number', 'secret',
      'sensitive_config_ref', 'sensitive_destination_ref', 'source_table',
      'special_requests', 'sql', 'token'
    ]::TEXT[]
  );
$$;

CREATE TABLE distribution.public_hotel_bookability_profiles (
  property_id                          UUID        PRIMARY KEY,
  finance_payment_settings_property_id UUID,
  contract_version                     TEXT        NOT NULL DEFAULT 'public-bookability.v1',
  public_visibility                    TEXT        NOT NULL DEFAULT 'public_safe',
  public_id                            TEXT        NOT NULL,
  canonical_slug                       TEXT        NOT NULL,
  canonical_url                        TEXT        NOT NULL,
  booking_base_url                     TEXT        NOT NULL,
  custom_domain_url                    TEXT,
  timezone                             TEXT        NOT NULL,
  default_locale                       TEXT        NOT NULL DEFAULT 'en',
  supported_locales                    TEXT[]      NOT NULL DEFAULT ARRAY['en']::TEXT[],
  default_currency                     CHAR(3)     NOT NULL,
  supported_currencies                 TEXT[]      NOT NULL,
  profile_status                       TEXT        NOT NULL DEFAULT 'incomplete'
                                      CHECK (profile_status IN ('public', 'incomplete', 'unpublished', 'stale', 'unavailable')),
  public_identity                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  location                             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  media                                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  amenities                            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  policies                             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  capabilities                         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  supported_quote_parameters           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  public_setup_completeness            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  freshness_status                     TEXT        NOT NULL DEFAULT 'unknown'
                                      CHECK (freshness_status IN ('fresh', 'stale', 'unknown', 'unavailable')),
  data_sources                         TEXT[]      NOT NULL DEFAULT ARRAY['hotel_catalog', 'distribution']::TEXT[],
  generated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                           TIMESTAMPTZ,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_distribution_bookability_profiles_public_id
    UNIQUE (public_id),
  CONSTRAINT chk_distribution_bookability_profiles_contract
    CHECK (contract_version = 'public-bookability.v1'),
  CONSTRAINT chk_distribution_bookability_profiles_public_visibility
    CHECK (public_visibility = 'public_safe'),
  CONSTRAINT chk_distribution_bookability_profiles_currency_upper
    CHECK (default_currency = upper(default_currency)),
  CONSTRAINT chk_distribution_bookability_profiles_locale_supported
    CHECK (default_locale = ANY(supported_locales)),
  CONSTRAINT chk_distribution_bookability_profiles_timezone
    CHECK (timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$'),
  CONSTRAINT chk_distribution_bookability_profiles_sources
    CHECK (
      'distribution' = ANY(data_sources)
      AND data_sources <@ ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']::TEXT[]
    ),
  CONSTRAINT chk_distribution_bookability_profiles_finance_property
    CHECK (
      finance_payment_settings_property_id IS NULL
      OR finance_payment_settings_property_id = property_id
    ),
  CONSTRAINT chk_distribution_bookability_profiles_public_json
    CHECK (
      NOT distribution.jsonb_has_distribution_private_key(public_identity)
      AND NOT distribution.jsonb_has_distribution_private_key(location)
      AND NOT distribution.jsonb_has_distribution_private_key(media)
      AND NOT distribution.jsonb_has_distribution_private_key(amenities)
      AND NOT distribution.jsonb_has_distribution_private_key(policies)
      AND NOT distribution.jsonb_has_distribution_private_key(capabilities)
      AND NOT distribution.jsonb_has_distribution_private_key(supported_quote_parameters)
      AND NOT distribution.jsonb_has_distribution_private_key(public_setup_completeness)
      AND NOT distribution.jsonb_has_distribution_private_key(source_freshness)
    ),
  CONSTRAINT fk_distribution_bookability_profiles_catalog_profile
    FOREIGN KEY (property_id)
    REFERENCES hotel_catalog.property_public_profile_read_model(property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_bookability_profiles_finance_settings
    FOREIGN KEY (finance_payment_settings_property_id)
    REFERENCES finance.payment_settings(property_id)
    ON DELETE SET NULL
);

CREATE INDEX idx_distribution_bookability_profiles_status
  ON distribution.public_hotel_bookability_profiles (profile_status, freshness_status);

CREATE TABLE distribution.public_room_offer_snapshots (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        NOT NULL,
  room_type_id             UUID        NOT NULL,
  rate_plan_id             UUID,
  stay_date                DATE        NOT NULL,
  public_offer_key         TEXT        NOT NULL,
  contract_version         TEXT        NOT NULL DEFAULT 'public-bookability.v1',
  public_visibility        TEXT        NOT NULL DEFAULT 'public_safe',
  availability_status      TEXT        NOT NULL DEFAULT 'available'
                                   CHECK (availability_status IN ('available', 'limited', 'sold_out', 'closed', 'stale', 'unavailable')),
  sellable_publicly        BOOLEAN     NOT NULL DEFAULT TRUE,
  available_rooms          INTEGER     NOT NULL DEFAULT 0 CHECK (available_rooms >= 0),
  base_price_amount        NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (base_price_amount >= 0),
  taxes_and_fees_amount    NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (taxes_and_fees_amount >= 0),
  discounts_amount         NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (discounts_amount >= 0),
  currency                 CHAR(3)     NOT NULL,
  occupancy                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  room_summary             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  rate_summary             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payment_options          TEXT[]      NOT NULL DEFAULT '{}',
  public_policy            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  unavailable_reasons      TEXT[]      NOT NULL DEFAULT '{}',
  source_freshness         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  freshness_status         TEXT        NOT NULL DEFAULT 'unknown'
                                   CHECK (freshness_status IN ('fresh', 'stale', 'unknown', 'unavailable')),
  data_sources             TEXT[]      NOT NULL DEFAULT ARRAY['pms', 'finance', 'booking', 'distribution']::TEXT[],
  generated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_distribution_room_offer_snapshots_offer_date
    UNIQUE (property_id, public_offer_key, stay_date),
  CONSTRAINT uq_distribution_room_offer_snapshots_id_property
    UNIQUE (id, property_id),
  CONSTRAINT chk_distribution_room_offer_snapshots_contract
    CHECK (contract_version = 'public-bookability.v1'),
  CONSTRAINT chk_distribution_room_offer_snapshots_public_visibility
    CHECK (public_visibility = 'public_safe'),
  CONSTRAINT chk_distribution_room_offer_snapshots_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_distribution_room_offer_snapshots_payment_options
    CHECK (
      payment_options <@ ARRAY[
        'card', 'pay_at_property', 'xendit', 'cash',
        'bank_transfer', 'manual_card', 'wallet', 'other'
      ]::TEXT[]
    ),
  CONSTRAINT chk_distribution_room_offer_snapshots_sources
    CHECK (
      'distribution' = ANY(data_sources)
      AND data_sources <@ ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']::TEXT[]
    ),
  CONSTRAINT chk_distribution_room_offer_snapshots_public_json
    CHECK (
      NOT distribution.jsonb_has_distribution_private_key(occupancy)
      AND NOT distribution.jsonb_has_distribution_private_key(room_summary)
      AND NOT distribution.jsonb_has_distribution_private_key(rate_summary)
      AND NOT distribution.jsonb_has_distribution_private_key(public_policy)
      AND NOT distribution.jsonb_has_distribution_private_key(source_freshness)
    ),
  CONSTRAINT fk_distribution_room_offer_snapshots_bookability_profile
    FOREIGN KEY (property_id)
    REFERENCES distribution.public_hotel_bookability_profiles(property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_room_offer_snapshots_inventory_day
    FOREIGN KEY (property_id, room_type_id, stay_date)
    REFERENCES pms.inventory_days(property_id, room_type_id, stay_date)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_room_offer_snapshots_rate_plan
    FOREIGN KEY (rate_plan_id, property_id, room_type_id)
    REFERENCES pms.rate_plans(id, property_id, room_type_id)
    ON DELETE SET NULL (rate_plan_id)
);

CREATE INDEX idx_distribution_room_offer_snapshots_property_date
  ON distribution.public_room_offer_snapshots (property_id, stay_date, availability_status);

CREATE INDEX idx_distribution_room_offer_snapshots_room_type
  ON distribution.public_room_offer_snapshots (room_type_id, stay_date);

CREATE TABLE distribution.public_quote_read_models (
  quote_session_id      UUID        PRIMARY KEY,
  property_id            UUID        NOT NULL,
  contract_version       TEXT        NOT NULL DEFAULT 'public-bookability.v1',
  public_visibility      TEXT        NOT NULL DEFAULT 'public_safe',
  public_quote_reference TEXT        NOT NULL,
  quote_hash             TEXT        NOT NULL,
  request_snapshot       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  quote_status           TEXT        NOT NULL
                              CHECK (quote_status IN ('bookable', 'unavailable', 'stale', 'error')),
  unavailable_reasons    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  offers                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  totals                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  deep_link_url          TEXT,
  price_guarantee        TEXT        NOT NULL DEFAULT 'expires_at'
                              CHECK (price_guarantee IN ('expires_at', 'none', 'request_only')),
  currency               CHAR(3)     NOT NULL,
  source_freshness       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  freshness_status       TEXT        NOT NULL DEFAULT 'unknown'
                              CHECK (freshness_status IN ('fresh', 'stale', 'unknown', 'unavailable')),
  data_sources           TEXT[]      NOT NULL DEFAULT ARRAY['booking', 'pms', 'finance', 'distribution']::TEXT[],
  generated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL,
  projected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_distribution_quote_read_models_public_reference
    UNIQUE (public_quote_reference),
  CONSTRAINT chk_distribution_quote_read_models_contract
    CHECK (contract_version = 'public-bookability.v1'),
  CONSTRAINT chk_distribution_quote_read_models_public_visibility
    CHECK (public_visibility = 'public_safe'),
  CONSTRAINT chk_distribution_quote_read_models_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_distribution_quote_read_models_sources
    CHECK (
      'distribution' = ANY(data_sources)
      AND data_sources <@ ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']::TEXT[]
    ),
  CONSTRAINT chk_distribution_quote_read_models_public_json
    CHECK (
      NOT distribution.jsonb_has_distribution_private_key(request_snapshot)
      AND NOT distribution.jsonb_has_distribution_private_key(unavailable_reasons)
      AND NOT distribution.jsonb_has_distribution_private_key(offers)
      AND NOT distribution.jsonb_has_distribution_private_key(totals)
      AND NOT distribution.jsonb_has_distribution_private_key(source_freshness)
    ),
  CONSTRAINT fk_distribution_quote_read_models_bookability_profile
    FOREIGN KEY (property_id)
    REFERENCES distribution.public_hotel_bookability_profiles(property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_quote_read_models_quote_property
    FOREIGN KEY (quote_session_id, property_id)
    REFERENCES booking.quote_sessions(id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_distribution_quote_read_models_property_status
  ON distribution.public_quote_read_models (property_id, quote_status, expires_at);

CREATE TABLE distribution.booking_deep_link_contexts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        NOT NULL,
  quote_session_id         UUID,
  checkout_context_id      UUID,
  public_quote_reference   TEXT,
  context_token_hash       TEXT        NOT NULL,
  deep_link_url            TEXT        NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'expired', 'converted', 'revoked')),
  locale                   TEXT        NOT NULL DEFAULT 'en',
  currency                 CHAR(3)     NOT NULL,
  check_in                 DATE        NOT NULL,
  check_out                DATE        NOT NULL,
  adults                   INTEGER     NOT NULL DEFAULT 1 CHECK (adults >= 1),
  children                 INTEGER     NOT NULL DEFAULT 0 CHECK (children >= 0),
  rooms                    INTEGER     NOT NULL DEFAULT 1 CHECK (rooms >= 1),
  promo_code               TEXT,
  referral_code            TEXT,
  preserves                TEXT[]      NOT NULL DEFAULT ARRAY[
                                    'dates', 'guests', 'rooms',
                                    'currency', 'locale', 'promo_code',
                                    'referral_code', 'quote_id'
                                  ]::TEXT[],
  request_context          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_distribution_deep_link_contexts_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_distribution_deep_link_contexts_token_hash
    UNIQUE (context_token_hash),
  CONSTRAINT chk_distribution_deep_link_contexts_date_order
    CHECK (check_in < check_out),
  CONSTRAINT chk_distribution_deep_link_contexts_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_distribution_deep_link_contexts_preserves
    CHECK (
      preserves <@ ARRAY[
        'dates', 'guests', 'rooms', 'currency', 'locale',
        'promo_code', 'referral_code', 'quote_id', 'room_type',
        'rate_plan'
      ]::TEXT[]
    ),
  CONSTRAINT chk_distribution_deep_link_contexts_checkout_quote_pair
    CHECK (checkout_context_id IS NULL OR quote_session_id IS NOT NULL),
  CONSTRAINT chk_distribution_deep_link_contexts_public_json
    CHECK (
      NOT distribution.jsonb_has_distribution_private_key(request_context)
      AND NOT distribution.jsonb_has_distribution_private_key(source_freshness)
    ),
  CONSTRAINT fk_distribution_deep_link_contexts_bookability_profile
    FOREIGN KEY (property_id)
    REFERENCES distribution.public_hotel_bookability_profiles(property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_deep_link_contexts_quote_property
    FOREIGN KEY (quote_session_id, property_id)
    REFERENCES booking.quote_sessions(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_distribution_deep_link_contexts_checkout_property
    FOREIGN KEY (checkout_context_id, property_id, quote_session_id)
    REFERENCES booking.checkout_contexts(id, property_id, quote_session_id)
    ON DELETE SET NULL (checkout_context_id)
);

CREATE INDEX idx_distribution_deep_link_contexts_property_status
  ON distribution.booking_deep_link_contexts (property_id, status, expires_at);

CREATE TABLE distribution.external_api_clients (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_client_id         TEXT        NOT NULL,
  client_name              TEXT        NOT NULL,
  contact_email            TEXT,
  status                   TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  allowed_surfaces         TEXT[]      NOT NULL DEFAULT ARRAY['public_profile', 'public_quote']::TEXT[],
  rate_limit_tier          TEXT        NOT NULL DEFAULT 'standard'
                                  CHECK (rate_limit_tier IN ('standard', 'partner', 'internal', 'blocked', 'migration')),
  terms_version            TEXT        NOT NULL,
  credential_hash_ref      TEXT,
  credential_rotated_at    TIMESTAMPTZ,
  created_by_user_id       UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  revoked_by_user_id       UUID        REFERENCES identity.users(id) ON DELETE SET NULL,
  revoked_at               TIMESTAMPTZ,
  revocation_reason        TEXT,
  last_seen_at             TIMESTAMPTZ,
  client_metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_distribution_external_api_clients_public_id
    UNIQUE (public_client_id),
  CONSTRAINT chk_distribution_external_api_clients_surfaces
    CHECK (
      allowed_surfaces <@ ARRAY[
        'public_profile', 'public_quote', 'deep_link',
        'partner_feed', 'mcp_tool'
      ]::TEXT[]
    ),
  CONSTRAINT chk_distribution_external_api_clients_revocation
    CHECK (
      (status = 'revoked' AND revoked_at IS NOT NULL)
      OR (
        status <> 'revoked'
        AND revoked_by_user_id IS NULL
        AND revoked_at IS NULL
        AND revocation_reason IS NULL
      )
    ),
  CONSTRAINT chk_distribution_external_api_clients_public_metadata
    CHECK (NOT distribution.jsonb_has_distribution_private_key(client_metadata))
);

CREATE INDEX idx_distribution_external_api_clients_status
  ON distribution.external_api_clients (status, rate_limit_tier);

CREATE TABLE distribution.external_api_usage_events (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                UUID        REFERENCES distribution.external_api_clients(id) ON DELETE RESTRICT,
  property_id              UUID        REFERENCES hotel_catalog.properties(id) ON DELETE SET NULL,
  quote_session_id         UUID,
  deep_link_context_id     UUID,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  surface                  TEXT        NOT NULL
                                  CHECK (surface IN ('public_profile', 'public_quote', 'deep_link', 'partner_feed', 'mcp_tool')),
  request_method           TEXT        NOT NULL
                                  CHECK (request_method IN ('GET', 'POST', 'HEAD', 'OPTIONS')),
  route_template           TEXT        NOT NULL,
  response_status          INTEGER     NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  rate_limit_policy        TEXT        NOT NULL,
  rate_limit_tier          TEXT        NOT NULL,
  rate_limit_key_hash      TEXT,
  request_fingerprint_hash TEXT,
  ip_address_hash          TEXT,
  user_agent_hash          TEXT,
  cache_status             TEXT        CHECK (cache_status IS NULL OR cache_status IN ('hit', 'miss', 'stale', 'bypass')),
  latency_ms               INTEGER     CHECK (latency_ms IS NULL OR latency_ms >= 0),
  client_visible_error_code TEXT,
  abuse_flags              TEXT[]      NOT NULL DEFAULT '{}',
  usage_metadata           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_distribution_usage_events_quote_property
    CHECK (quote_session_id IS NULL OR property_id IS NOT NULL),
  CONSTRAINT chk_distribution_usage_events_deep_link_property
    CHECK (deep_link_context_id IS NULL OR property_id IS NOT NULL),
  CONSTRAINT chk_distribution_usage_events_public_metadata
    CHECK (NOT distribution.jsonb_has_distribution_private_key(usage_metadata)),
  CONSTRAINT fk_distribution_usage_events_quote_property
    FOREIGN KEY (quote_session_id, property_id)
    REFERENCES booking.quote_sessions(id, property_id)
    ON DELETE SET NULL (quote_session_id),
  CONSTRAINT fk_distribution_usage_events_deep_link_property
    FOREIGN KEY (deep_link_context_id, property_id)
    REFERENCES distribution.booking_deep_link_contexts(id, property_id)
    ON DELETE SET NULL (deep_link_context_id)
);

CREATE INDEX idx_distribution_usage_events_client_time
  ON distribution.external_api_usage_events (client_id, occurred_at);

CREATE INDEX idx_distribution_usage_events_property_time
  ON distribution.external_api_usage_events (property_id, occurred_at);

CREATE INDEX idx_distribution_usage_events_surface_time
  ON distribution.external_api_usage_events (surface, occurred_at);
