-- Migration: 0005_booking_checkout
-- Owner: domain-booking
-- See: engineering/target-schema-migration-coverage.md, engineering/target-schema-ownership-map.md
--
-- Creates the booking/checkout target schema for direct booking quotes,
-- checkout state, guest-facing booking lifecycle records, public-safe booking
-- status, and permissioned summary read models.
--
-- Legacy Booking/PMS databases are migration/parity inputs only. Runtime
-- TypeScript code must not use this migration as a reason to read legacy
-- Booking/PMS databases directly.

CREATE SCHEMA IF NOT EXISTS booking;

CREATE TABLE booking.quote_sessions (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  request_hash             TEXT        NOT NULL,
  public_quote_reference   TEXT        NOT NULL UNIQUE,
  requested_check_in       DATE        NOT NULL,
  requested_check_out      DATE        NOT NULL,
  adults                   INTEGER     NOT NULL DEFAULT 1 CHECK (adults >= 1),
  children                 INTEGER     NOT NULL DEFAULT 0 CHECK (children >= 0),
  requested_room_count     INTEGER     NOT NULL DEFAULT 1 CHECK (requested_room_count >= 1),
  currency                 CHAR(3)     NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'expired', 'converted', 'unavailable')),
  selected_offer_snapshot  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  totals                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  unavailable_reasons      TEXT[]      NOT NULL DEFAULT '{}',
  policy_snapshot          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  promo_code               TEXT,
  referral_code            TEXT,
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_quote_sessions_date_order
    CHECK (requested_check_in < requested_check_out),
  CONSTRAINT chk_quote_sessions_currency_upper
    CHECK (currency = upper(currency))
);

CREATE TABLE booking.checkout_contexts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_session_id         UUID        REFERENCES booking.quote_sessions(id) ON DELETE SET NULL,
  property_id              UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  locale                   TEXT        NOT NULL DEFAULT 'en',
  currency                 CHAR(3)     NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'abandoned', 'converted', 'expired')),
  guest_input              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  selected_addons          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  payment_context          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  promo_context            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  expires_at               TIMESTAMPTZ NOT NULL,
  converted_guest_booking_id UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_checkout_contexts_currency_upper
    CHECK (currency = upper(currency))
);

CREATE TABLE booking.guest_bookings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  quote_session_id      UUID        REFERENCES booking.quote_sessions(id) ON DELETE SET NULL,
  checkout_context_id   UUID        REFERENCES booking.checkout_contexts(id) ON DELETE SET NULL,
  public_reference      TEXT        NOT NULL UNIQUE,
  source_system         TEXT        NOT NULL DEFAULT 'booking'
                            CHECK (source_system IN ('booking', 'pms', 'migration')),
  source_booking_id     TEXT,
  lifecycle_status      TEXT        NOT NULL
                            CHECK (lifecycle_status IN (
                              'draft', 'pending_payment', 'confirmed', 'declined',
                              'canceled', 'completed', 'no_show', 'expired'
                            )),
  payment_status        TEXT        NOT NULL DEFAULT 'unpaid'
                            CHECK (payment_status IN (
                              'unpaid', 'authorized', 'partially_paid', 'paid',
                              'refunded', 'failed', 'waived'
                            )),
  check_in              DATE        NOT NULL,
  check_out             DATE        NOT NULL,
  adults                INTEGER     NOT NULL DEFAULT 1 CHECK (adults >= 1),
  children              INTEGER     NOT NULL DEFAULT 0 CHECK (children >= 0),
  room_count            INTEGER     NOT NULL DEFAULT 1 CHECK (room_count >= 1),
  currency              CHAR(3)     NOT NULL,
  total_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  balance_amount        NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (balance_amount >= 0),
  cancellation_reason   TEXT,
  booking_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_guest_bookings_source
    UNIQUE (source_system, source_booking_id),
  CONSTRAINT chk_guest_bookings_date_order
    CHECK (check_in < check_out),
  CONSTRAINT chk_guest_bookings_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_guest_bookings_source_id
    CHECK (source_system = 'booking' OR source_booking_id IS NOT NULL)
);

ALTER TABLE booking.checkout_contexts
  ADD CONSTRAINT fk_checkout_contexts_converted_booking
  FOREIGN KEY (converted_guest_booking_id)
  REFERENCES booking.guest_bookings(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE booking.booking_guests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_booking_id      UUID        NOT NULL REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  guest_role            TEXT        NOT NULL CHECK (guest_role IN ('booker', 'primary_guest', 'additional_guest')),
  first_name            TEXT        NOT NULL,
  last_name             TEXT        NOT NULL,
  email                 TEXT,
  phone                 TEXT,
  country_code          CHAR(2),
  arrival_time          TEXT,
  special_requests      TEXT,
  pii_retention_until   DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_booking_guests_country_upper
    CHECK (country_code IS NULL OR country_code = upper(country_code))
);

CREATE UNIQUE INDEX uq_booking_guests_one_booker
  ON booking.booking_guests (guest_booking_id)
  WHERE guest_role = 'booker';

CREATE TABLE booking.addon_definitions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  source_system          TEXT        NOT NULL DEFAULT 'booking'
                            CHECK (source_system IN ('booking', 'pms', 'migration')),
  source_addon_id        TEXT,
  name                  TEXT        NOT NULL,
  description           TEXT,
  category              TEXT,
  pricing_model         TEXT        NOT NULL
                            CHECK (pricing_model IN ('per_stay', 'per_night', 'per_guest', 'per_guest_night')),
  price_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
  currency              CHAR(3)     NOT NULL,
  public_visible        BOOLEAN     NOT NULL DEFAULT TRUE,
  status                TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'retired')),
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_addon_definitions_source
    UNIQUE (source_system, source_addon_id),
  CONSTRAINT chk_addon_definitions_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_addon_definitions_source_id
    CHECK (source_system = 'booking' OR source_addon_id IS NOT NULL)
);

CREATE TABLE booking.booking_addon_selections (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_booking_id      UUID        REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  quote_session_id      UUID        REFERENCES booking.quote_sessions(id) ON DELETE CASCADE,
  addon_definition_id   UUID        REFERENCES booking.addon_definitions(id) ON DELETE SET NULL,
  addon_snapshot        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  quantity              INTEGER     NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  service_date          DATE,
  total_amount          NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  currency              CHAR(3)     NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_booking_addon_selection_parent
    CHECK (
      (guest_booking_id IS NOT NULL AND quote_session_id IS NULL)
      OR
      (guest_booking_id IS NULL AND quote_session_id IS NOT NULL)
    ),
  CONSTRAINT chk_booking_addon_selections_currency_upper
    CHECK (currency = upper(currency))
);

CREATE TABLE booking.promo_applications (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  quote_session_id       UUID        REFERENCES booking.quote_sessions(id) ON DELETE CASCADE,
  guest_booking_id       UUID        REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  promo_code             TEXT        NOT NULL,
  application_status     TEXT        NOT NULL
                              CHECK (application_status IN ('applied', 'rejected', 'expired', 'reversed')),
  discount_amount        NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  currency               CHAR(3)     NOT NULL,
  metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_promo_applications_target
    CHECK (quote_session_id IS NOT NULL OR guest_booking_id IS NOT NULL),
  CONSTRAINT chk_promo_applications_currency_upper
    CHECK (currency = upper(currency))
);

CREATE TABLE booking.booking_status_events (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_booking_id      UUID        NOT NULL REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  event_type            TEXT        NOT NULL,
  from_status           TEXT,
  to_status             TEXT,
  actor_type            TEXT        NOT NULL CHECK (actor_type IN ('guest', 'property_user', 'system', 'migration')),
  actor_user_id         UUID        REFERENCES identity.users(id),
  public_visible        BOOLEAN     NOT NULL DEFAULT FALSE,
  public_message        TEXT,
  event_payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE booking.booking_change_requests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_booking_id      UUID        NOT NULL REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  request_type          TEXT        NOT NULL
                            CHECK (request_type IN ('date_change', 'guest_count_change', 'addon_change', 'cancellation')),
  requested_by          TEXT        NOT NULL CHECK (requested_by IN ('guest', 'property_user', 'system')),
  status                TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'declined', 'canceled', 'expired')),
  requested_changes     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  decision_actor_user_id UUID       REFERENCES identity.users(id),
  decision_note         TEXT,
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_booking_change_requests_decision
    CHECK (
      (status IN ('accepted', 'declined') AND decided_at IS NOT NULL)
      OR
      (status NOT IN ('accepted', 'declined'))
    )
);

CREATE TABLE booking.booking_notes_public (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_booking_id      UUID        NOT NULL REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  author_type           TEXT        NOT NULL CHECK (author_type IN ('guest', 'property_user', 'system', 'migration')),
  author_user_id        UUID        REFERENCES identity.users(id),
  body                  TEXT        NOT NULL,
  locale                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permissioned read model. Deliberately excludes guest names, emails, phone
-- numbers, special requests, note bodies, and raw checkout input.
CREATE TABLE booking.direct_booking_summary_read_model (
  guest_booking_id      UUID        PRIMARY KEY REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  property_id           UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  public_reference      TEXT        NOT NULL UNIQUE,
  lifecycle_status      TEXT        NOT NULL,
  payment_status        TEXT        NOT NULL,
  check_in              DATE        NOT NULL,
  check_out             DATE        NOT NULL,
  guest_counts          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  room_summary          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  amount_summary        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  public_policy         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source_freshness      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  projected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_direct_booking_summary_date_order
    CHECK (check_in < check_out)
);

CREATE INDEX idx_quote_sessions_property_dates
  ON booking.quote_sessions (property_id, requested_check_in, requested_check_out);

CREATE INDEX idx_quote_sessions_request_hash
  ON booking.quote_sessions (property_id, request_hash);

CREATE INDEX idx_checkout_contexts_quote
  ON booking.checkout_contexts (quote_session_id);

CREATE INDEX idx_guest_bookings_property_dates
  ON booking.guest_bookings (property_id, check_in, check_out);

CREATE INDEX idx_guest_bookings_lifecycle_status
  ON booking.guest_bookings (lifecycle_status);

CREATE INDEX idx_booking_guests_booking
  ON booking.booking_guests (guest_booking_id);

CREATE INDEX idx_addon_definitions_property_status
  ON booking.addon_definitions (property_id, status);

CREATE INDEX idx_booking_addon_selections_booking
  ON booking.booking_addon_selections (guest_booking_id);

CREATE INDEX idx_booking_addon_selections_quote
  ON booking.booking_addon_selections (quote_session_id);

CREATE INDEX idx_promo_applications_quote
  ON booking.promo_applications (quote_session_id);

CREATE INDEX idx_promo_applications_booking
  ON booking.promo_applications (guest_booking_id);

CREATE INDEX idx_booking_status_events_booking
  ON booking.booking_status_events (guest_booking_id, occurred_at);

CREATE INDEX idx_booking_change_requests_booking
  ON booking.booking_change_requests (guest_booking_id, status);

CREATE INDEX idx_direct_booking_summary_property_dates
  ON booking.direct_booking_summary_read_model (property_id, check_in, check_out);
