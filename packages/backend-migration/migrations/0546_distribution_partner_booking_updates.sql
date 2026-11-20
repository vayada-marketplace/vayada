-- Migration: 0546_distribution_partner_booking_updates
-- Owner: distribution / VAY-2438
--
-- Signed booking updates for bookings that used a connected partner app's code (contract "What
-- Vayada accepts and sends", section 3). A job compares each such booking with what was last sent to
-- the app (Flamur, 2026-11-20: every minute, not in each booking transaction) and writes the next
-- version as a platform.outbox_events row (destination 'partner_webhook'); another job delivers it.
--
-- partner_booking_states holds, per booking and app, the last version sent, the hash of the booking
-- as it was sent (no guest data) and its status; updated_at lets the catch-up reads (VAY-2440) list
-- what changed since a time. webhook_secret_version picks the app's webhook signing secret, which is
-- derived from a key in next-api's environment and never stored; bumping it rotates the secret.
--
-- New product tables: the API login gets its DML from the default privileges (no GRANT here).

SET LOCAL lock_timeout = '5s';

ALTER TABLE distribution.external_api_clients
  ADD COLUMN webhook_secret_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_distribution_external_api_clients_webhook_secret_version
    CHECK (webhook_secret_version >= 1);

CREATE TABLE distribution.partner_booking_states (
  guest_booking_id  UUID        NOT NULL REFERENCES booking.guest_bookings(id) ON DELETE CASCADE,
  client_id         UUID        NOT NULL
                      REFERENCES distribution.external_api_clients(id) ON DELETE RESTRICT,
  property_id       UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  version           INTEGER     NOT NULL CHECK (version >= 1),
  status            TEXT        NOT NULL
                      CHECK (status IN ('confirmed', 'cancelled', 'no_show', 'checked_out')),
  snapshot_hash     TEXT        NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guest_booking_id, client_id)
);

CREATE INDEX idx_distribution_partner_booking_states_updated
  ON distribution.partner_booking_states (client_id, property_id, updated_at);
