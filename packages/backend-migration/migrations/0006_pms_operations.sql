-- Migration: 0006_pms_operations
-- Owner: domain-pms
-- See: engineering/target-schema-migration-coverage.md, engineering/target-schema-ownership-map.md,
--      engineering/pms-reservation-integration-contract.md
--
-- Creates the PMS operations target schema for operational rooms, rates,
-- inventory, room assignments, private operational booking state, PMS guest
-- messaging, and channel-manager mappings.
--
-- Legacy PMS/Booking databases are migration/parity inputs only. Runtime
-- TypeScript code must not use this migration as a reason to read legacy
-- PMS/Booking databases directly.

CREATE SCHEMA IF NOT EXISTS pms;

CREATE TABLE pms.room_types (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  source_system          TEXT        NOT NULL DEFAULT 'pms'
                            CHECK (source_system IN ('pms', 'migration')),
  source_room_type_id    TEXT,
  name                  TEXT        NOT NULL,
  description           TEXT        NOT NULL DEFAULT '',
  category              TEXT,
  occupancy_limits      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  room_attributes       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  amenities_snapshot    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  media_snapshot        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  base_rate_amount      NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (base_rate_amount >= 0),
  currency              CHAR(3)     NOT NULL,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order            INTEGER     NOT NULL DEFAULT 0,
  location_summary      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_room_types_source
    UNIQUE (property_id, source_system, source_room_type_id),
  CONSTRAINT uq_pms_room_types_id_property
    UNIQUE (id, property_id),
  CONSTRAINT chk_pms_room_types_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT chk_pms_room_types_source_id
    CHECK (source_system = 'pms' OR source_room_type_id IS NOT NULL)
);

CREATE TABLE pms.rooms (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id          UUID        NOT NULL,
  source_system          TEXT        NOT NULL DEFAULT 'pms'
                            CHECK (source_system IN ('pms', 'migration')),
  source_room_id        TEXT,
  room_number           TEXT        NOT NULL,
  floor                 TEXT,
  status                TEXT        NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available', 'maintenance', 'out_of_order', 'retired')),
  sort_order            INTEGER     NOT NULL DEFAULT 0,
  room_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_rooms_property_number
    UNIQUE (property_id, room_number),
  CONSTRAINT uq_pms_rooms_source
    UNIQUE (property_id, source_system, source_room_id),
  CONSTRAINT uq_pms_rooms_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_pms_rooms_id_property_room_type
    UNIQUE (id, property_id, room_type_id),
  CONSTRAINT chk_pms_rooms_source_id
    CHECK (source_system = 'pms' OR source_room_id IS NOT NULL),
  CONSTRAINT fk_pms_rooms_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.rate_plans (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id          UUID        NOT NULL,
  code                  TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  rate_type             TEXT        NOT NULL DEFAULT 'flexible'
                            CHECK (rate_type IN ('flexible', 'non_refundable', 'package', 'manual')),
  meal_plan             TEXT,
  payment_policy        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  deposit_policy        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  cancellation_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  base_rate_amount      NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (base_rate_amount >= 0),
  currency              CHAR(3)     NOT NULL,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_rate_plans_property_room_code
    UNIQUE (property_id, room_type_id, code),
  CONSTRAINT uq_pms_rate_plans_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_pms_rate_plans_id_property_room_type
    UNIQUE (id, property_id, room_type_id),
  CONSTRAINT chk_pms_rate_plans_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT fk_pms_rate_plans_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.rate_rules (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id          UUID        NOT NULL,
  rate_plan_id          UUID,
  rule_type             TEXT        NOT NULL
                            CHECK (rule_type IN (
                              'season', 'daily_rate', 'monthly_rate', 'weekend_surcharge',
                              'stay_restriction', 'arrival_departure_restriction',
                              'advance_booking', 'last_minute_discount'
                            )),
  starts_on             DATE        NOT NULL,
  ends_on               DATE        NOT NULL,
  days_of_week          INTEGER[]   NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::INTEGER[],
  min_stay_nights       INTEGER     CHECK (min_stay_nights IS NULL OR min_stay_nights >= 1),
  max_stay_nights       INTEGER     CHECK (max_stay_nights IS NULL OR max_stay_nights >= 1),
  closed_to_arrival     BOOLEAN     NOT NULL DEFAULT FALSE,
  closed_to_departure   BOOLEAN     NOT NULL DEFAULT FALSE,
  price_delta_amount    NUMERIC(15, 2),
  price_delta_percent   NUMERIC(7, 4),
  rule_payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pms_rate_rules_date_order
    CHECK (starts_on <= ends_on),
  CONSTRAINT chk_pms_rate_rules_stay_order
    CHECK (max_stay_nights IS NULL OR min_stay_nights IS NULL OR min_stay_nights <= max_stay_nights),
  CONSTRAINT chk_pms_rate_rules_days_of_week
    CHECK (
      cardinality(days_of_week) BETWEEN 1 AND 7
      AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::INTEGER[]
    ),
  CONSTRAINT fk_pms_rate_rules_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_rate_rules_rate_plan_property
    FOREIGN KEY (rate_plan_id, property_id, room_type_id)
    REFERENCES pms.rate_plans(id, property_id, room_type_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.inventory_days (
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id          UUID        NOT NULL,
  stay_date             DATE        NOT NULL,
  total_count           INTEGER     NOT NULL CHECK (total_count >= 0),
  assigned_count        INTEGER     NOT NULL DEFAULT 0 CHECK (assigned_count >= 0),
  blocked_count         INTEGER     NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  available_count       INTEGER     NOT NULL CHECK (available_count >= 0),
  status                TEXT        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed', 'limited')),
  source_freshness      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, room_type_id, stay_date),
  CONSTRAINT chk_pms_inventory_days_count_balance
    CHECK (available_count + assigned_count + blocked_count <= total_count),
  CONSTRAINT fk_pms_inventory_days_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.room_blocks (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id          UUID        NOT NULL,
  room_id               UUID,
  starts_on             DATE        NOT NULL,
  ends_on               DATE        NOT NULL,
  blocked_count         INTEGER     NOT NULL DEFAULT 1 CHECK (blocked_count >= 1),
  reason                TEXT        NOT NULL DEFAULT '',
  status                TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'released', 'expired')),
  created_by_user_id    UUID        REFERENCES identity.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at           TIMESTAMPTZ,
  CONSTRAINT chk_pms_room_blocks_date_order
    CHECK (starts_on <= ends_on),
  CONSTRAINT fk_pms_room_blocks_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_room_blocks_room_property
    FOREIGN KEY (room_id, property_id, room_type_id)
    REFERENCES pms.rooms(id, property_id, room_type_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.operational_booking_assignments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID        NOT NULL,
  room_type_id          UUID        NOT NULL,
  rate_plan_id          UUID,
  room_id               UUID,
  position              INTEGER     NOT NULL DEFAULT 1,
  assignment_status     TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (assignment_status IN (
                              'pending', 'assigned', 'checked_in', 'in_house',
                              'checked_out', 'canceled', 'released'
                            )),
  pms_reservation_ref   TEXT,
  external_reservation_id TEXT,
  channel               TEXT        NOT NULL DEFAULT 'direct',
  source                TEXT        NOT NULL DEFAULT 'direct_booking'
                            CHECK (source IN ('direct_booking', 'channel', 'manual', 'migration')),
  assignment_payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  assigned_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_operational_assignments_booking_position
    UNIQUE (guest_booking_id, position),
  CONSTRAINT chk_pms_operational_assignments_position
    CHECK (position >= 1),
  CONSTRAINT uq_pms_operational_assignments_id_property
    UNIQUE (id, property_id),
  CONSTRAINT uq_pms_operational_assignments_id_property_booking
    UNIQUE (id, property_id, guest_booking_id),
  CONSTRAINT fk_pms_operational_assignments_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_operational_assignments_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_pms_operational_assignments_rate_plan_property
    FOREIGN KEY (rate_plan_id, property_id, room_type_id)
    REFERENCES pms.rate_plans(id, property_id, room_type_id)
    ON DELETE SET NULL (rate_plan_id),
  CONSTRAINT fk_pms_operational_assignments_room_property
    FOREIGN KEY (room_id, property_id, room_type_id)
    REFERENCES pms.rooms(id, property_id, room_type_id)
    ON DELETE SET NULL (room_id)
);

CREATE TABLE pms.checkin_checklist_templates (
  property_id           UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  steps                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_by_user_id    UUID        REFERENCES identity.users(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pms.checkout_inspection_templates (
  property_id           UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  steps                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_by_user_id    UUID        REFERENCES identity.users(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pms.booking_checkin_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID        NOT NULL,
  assignment_id         UUID,
  completed_by_user_id  UUID        REFERENCES identity.users(id),
  completed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  step_results          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  pending_flags         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT fk_pms_checkin_records_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_checkin_records_assignment_property
    FOREIGN KEY (assignment_id, property_id, guest_booking_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (assignment_id)
);

CREATE TABLE pms.booking_checkout_charges (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID        NOT NULL,
  assignment_id         UUID,
  label                 TEXT        NOT NULL,
  amount                NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
  original_amount       NUMERIC(15, 2) NOT NULL CHECK (original_amount >= 0),
  currency              CHAR(3)     NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'paid', 'waived', 'void')),
  created_by_user_id    UUID        REFERENCES identity.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at            TIMESTAMPTZ,
  waived_at             TIMESTAMPTZ,
  CONSTRAINT chk_pms_checkout_charges_currency_upper
    CHECK (currency = upper(currency)),
  CONSTRAINT fk_pms_checkout_charges_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_checkout_charges_assignment_property
    FOREIGN KEY (assignment_id, property_id, guest_booking_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (assignment_id)
);

CREATE TABLE pms.booking_checkout_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID        NOT NULL,
  assignment_id         UUID,
  completed_by_user_id  UUID        REFERENCES identity.users(id),
  completed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  inspection_results    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  charges_settled       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  pending_flags         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  checkout_notes        TEXT,
  CONSTRAINT fk_pms_checkout_records_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_checkout_records_assignment_property
    FOREIGN KEY (assignment_id, property_id, guest_booking_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (assignment_id)
);

CREATE TABLE pms.booking_notes_private (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID        NOT NULL,
  author_user_id        UUID        REFERENCES identity.users(id),
  author_display_name   TEXT        NOT NULL DEFAULT '',
  body                  TEXT        NOT NULL,
  source                TEXT        NOT NULL DEFAULT 'pms'
                            CHECK (source IN ('pms', 'migration', 'system')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_pms_booking_notes_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.message_threads (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id      UUID,
  source                TEXT        NOT NULL CHECK (source IN ('channex', 'manual', 'migration')),
  source_thread_id      TEXT        NOT NULL,
  source_booking_id     TEXT,
  channel               TEXT,
  guest_display_name    TEXT,
  guest_email           TEXT,
  status                TEXT        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed', 'no_reply_needed')),
  last_message_at       TIMESTAMPTZ,
  last_message_preview  TEXT,
  last_message_direction TEXT       CHECK (
                              last_message_direction IS NULL
                              OR last_message_direction IN ('inbound', 'outbound')
                            ),
  unread_count          INTEGER     NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_message_threads_source
    UNIQUE (property_id, source, source_thread_id),
  CONSTRAINT uq_pms_message_threads_id_property
    UNIQUE (id, property_id),
  CONSTRAINT fk_pms_message_threads_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE SET NULL (guest_booking_id)
);

CREATE TABLE pms.messages (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  thread_id             UUID        NOT NULL,
  source_message_id     TEXT        NOT NULL,
  direction             TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type           TEXT        NOT NULL DEFAULT 'guest'
                            CHECK (sender_type IN ('guest', 'property_user', 'channel', 'system')),
  sender_user_id        UUID        REFERENCES identity.users(id),
  sender_display_name   TEXT,
  body                  TEXT        NOT NULL DEFAULT '',
  sent_at               TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at               TIMESTAMPTZ,
  raw_payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  pii_retention_until   DATE,
  CONSTRAINT uq_pms_messages_thread_source_message
    UNIQUE (thread_id, source_message_id),
  CONSTRAINT uq_pms_messages_id_property
    UNIQUE (id, property_id),
  CONSTRAINT fk_pms_messages_thread_property
    FOREIGN KEY (thread_id, property_id)
    REFERENCES pms.message_threads(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.message_attachments (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  message_id            UUID        NOT NULL,
  s3_key                TEXT,
  source_url            TEXT,
  filename              TEXT,
  content_type          TEXT,
  size_bytes            INTEGER     CHECK (size_bytes IS NULL OR size_bytes >= 0),
  source_attachment_id  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_pms_message_attachments_message_property
    FOREIGN KEY (message_id, property_id)
    REFERENCES pms.messages(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.channel_connections (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  provider              TEXT        NOT NULL CHECK (provider IN ('channex', 'custom', 'migration')),
  connection_status     TEXT        NOT NULL DEFAULT 'setup_incomplete'
                            CHECK (connection_status IN (
                              'connected', 'disconnected', 'suspended',
                              'degraded', 'setup_incomplete'
                            )),
  external_property_id  TEXT,
  capabilities          TEXT[]      NOT NULL DEFAULT '{}',
  messaging_app_installed BOOLEAN   NOT NULL DEFAULT FALSE,
  last_booking_sync_at  TIMESTAMPTZ,
  last_ari_sync_at      TIMESTAMPTZ,
  last_message_sync_at  TIMESTAMPTZ,
  connection_metadata   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_connections_property_provider
    UNIQUE (property_id, provider),
  CONSTRAINT uq_pms_channel_connections_id_property
    UNIQUE (id, property_id)
);

CREATE TABLE pms.channel_room_type_mappings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id         UUID        NOT NULL,
  room_type_id          UUID        NOT NULL,
  external_room_type_id TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'stale')),
  mapping_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_room_mappings_external
    UNIQUE (connection_id, external_room_type_id),
  CONSTRAINT uq_pms_channel_room_mappings_room_type
    UNIQUE (connection_id, room_type_id),
  CONSTRAINT fk_pms_channel_room_mappings_connection_property
    FOREIGN KEY (connection_id, property_id)
    REFERENCES pms.channel_connections(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_channel_room_mappings_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.channel_rate_plan_mappings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id         UUID        NOT NULL,
  room_type_id          UUID        NOT NULL,
  rate_plan_id          UUID        NOT NULL,
  channel               TEXT        NOT NULL DEFAULT 'direct',
  external_room_type_id TEXT        NOT NULL,
  external_rate_plan_id TEXT        NOT NULL,
  sell_mode             TEXT        NOT NULL DEFAULT 'per_room'
                            CHECK (sell_mode IN ('per_room', 'per_person')),
  markup_percent        NUMERIC(7, 4) NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'stale')),
  mapping_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_rate_mappings_external
    UNIQUE (connection_id, external_rate_plan_id),
  CONSTRAINT uq_pms_channel_rate_mappings_rate_channel
    UNIQUE (connection_id, rate_plan_id, channel),
  CONSTRAINT fk_pms_channel_rate_mappings_connection_property
    FOREIGN KEY (connection_id, property_id)
    REFERENCES pms.channel_connections(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_channel_rate_mappings_room_type_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_channel_rate_mappings_rate_plan_property
    FOREIGN KEY (rate_plan_id, property_id, room_type_id)
    REFERENCES pms.rate_plans(id, property_id, room_type_id)
    ON DELETE CASCADE
);

CREATE TABLE pms.channel_booking_mappings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id         UUID        NOT NULL,
  guest_booking_id      UUID        NOT NULL,
  assignment_id         UUID,
  external_booking_id   TEXT        NOT NULL,
  external_revision_id  TEXT,
  channel               TEXT        NOT NULL DEFAULT 'channex',
  channel_room_index    INTEGER     NOT NULL DEFAULT 0 CHECK (channel_room_index >= 0),
  sync_status           TEXT        NOT NULL DEFAULT 'active'
                            CHECK (sync_status IN ('active', 'superseded', 'failed', 'ignored')),
  last_synced_at        TIMESTAMPTZ,
  mapping_metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_booking_mappings_external_slot
    UNIQUE (connection_id, external_booking_id, channel_room_index),
  CONSTRAINT fk_pms_channel_booking_mappings_connection_property
    FOREIGN KEY (connection_id, property_id)
    REFERENCES pms.channel_connections(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_channel_booking_mappings_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_channel_booking_mappings_assignment_property
    FOREIGN KEY (assignment_id, property_id, guest_booking_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (assignment_id)
);

CREATE TABLE pms.channel_sync_status (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id            UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id         UUID        NOT NULL,
  sync_domain           TEXT        NOT NULL
                            CHECK (sync_domain IN ('booking', 'ari', 'message', 'mapping')),
  status                TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'ok', 'degraded', 'failed')),
  last_attempt_at       TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_error_code       TEXT,
  last_error_message    TEXT,
  retry_after           TIMESTAMPTZ,
  sync_payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pms_channel_sync_status_connection_domain
    UNIQUE (connection_id, sync_domain),
  CONSTRAINT fk_pms_channel_sync_status_connection_property
    FOREIGN KEY (connection_id, property_id)
    REFERENCES pms.channel_connections(id, property_id)
    ON DELETE CASCADE
);

CREATE INDEX idx_pms_room_types_property_active
  ON pms.room_types (property_id, active);

CREATE INDEX idx_pms_rooms_room_type_status
  ON pms.rooms (room_type_id, status);

CREATE INDEX idx_pms_rate_plans_room_type_active
  ON pms.rate_plans (room_type_id, active);

CREATE INDEX idx_pms_rate_rules_room_type_dates
  ON pms.rate_rules (room_type_id, starts_on, ends_on);

CREATE INDEX idx_pms_inventory_days_property_date
  ON pms.inventory_days (property_id, stay_date);

CREATE INDEX idx_pms_room_blocks_room_type_dates
  ON pms.room_blocks (room_type_id, starts_on, ends_on);

CREATE INDEX idx_pms_operational_assignments_booking
  ON pms.operational_booking_assignments (guest_booking_id, property_id);

CREATE INDEX idx_pms_operational_assignments_room
  ON pms.operational_booking_assignments (room_id, assignment_status);

CREATE INDEX idx_pms_checkin_records_booking
  ON pms.booking_checkin_records (guest_booking_id, completed_at DESC);

CREATE INDEX idx_pms_checkout_charges_booking
  ON pms.booking_checkout_charges (guest_booking_id, created_at);

CREATE INDEX idx_pms_checkout_records_booking
  ON pms.booking_checkout_records (guest_booking_id, completed_at DESC);

CREATE INDEX idx_pms_booking_notes_booking
  ON pms.booking_notes_private (guest_booking_id, created_at DESC);

CREATE INDEX idx_pms_message_threads_property_recent
  ON pms.message_threads (property_id, last_message_at DESC NULLS LAST);

CREATE INDEX idx_pms_messages_thread_sent
  ON pms.messages (thread_id, sent_at);

CREATE INDEX idx_pms_message_attachments_message
  ON pms.message_attachments (message_id);

CREATE INDEX idx_pms_channel_connections_property_status
  ON pms.channel_connections (property_id, connection_status);

CREATE INDEX idx_pms_channel_room_mappings_room_type
  ON pms.channel_room_type_mappings (room_type_id);

CREATE INDEX idx_pms_channel_rate_mappings_rate_plan
  ON pms.channel_rate_plan_mappings (rate_plan_id);

CREATE INDEX idx_pms_channel_booking_mappings_booking
  ON pms.channel_booking_mappings (guest_booking_id, property_id);

CREATE INDEX idx_pms_channel_sync_status_status
  ON pms.channel_sync_status (status, retry_after);
