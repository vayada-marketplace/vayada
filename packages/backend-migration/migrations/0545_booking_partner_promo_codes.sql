-- Migration: 0545_booking_partner_promo_codes
-- Owner: booking / VAY-2437
--
-- A connected partner app (VAY-2436, 0544) makes, changes and retires its own promo codes for a hotel
-- through /partner/v1/promo-codes. partner_client_id marks such a code: the partner sees and changes
-- only its own codes, and the hotel sees them on its Promos page but can't change them there.
-- external_id is the partner's own id for the code, echoed back to it. Partner codes are only ever
-- retired, never deleted, so promo_applications keep pointing at them; RESTRICT keeps an app with
-- codes from being deleted.

SET LOCAL lock_timeout = '5s';

ALTER TABLE booking.promo_definitions
  ADD COLUMN partner_client_id UUID
    REFERENCES distribution.external_api_clients(id) ON DELETE RESTRICT,
  ADD COLUMN external_id TEXT,
  ADD CONSTRAINT chk_promo_definitions_partner_external_id
    CHECK (
      external_id IS NULL
      OR (partner_client_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 200)
    );

CREATE INDEX idx_promo_definitions_partner
  ON booking.promo_definitions (partner_client_id, property_id)
  WHERE partner_client_id IS NOT NULL;
