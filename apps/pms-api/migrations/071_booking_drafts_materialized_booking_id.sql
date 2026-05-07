-- VAY-388 follow-up: preserve the draft → booking link after
-- materialization so confirm-authorization stays idempotent.
--
-- Materialization originally DELETEd the draft as its atomic claim.
-- That broke a webhook + frontend race: when both call
-- confirm-authorization for the same draft, the second one finds no
-- draft AND no booking-by-draft-id, and 400s. We now soft-claim the
-- draft by stamping the resulting booking_id atomically on the row,
-- so a second caller (sequential or racing) can resolve back to the
-- materialized booking.

-- No FK to bookings(id): the column is stamped *before* the booking
-- INSERT (the pre-allocated id is the atomic-claim signal), so an
-- IMMEDIATE FK fires before the row exists. A dangling UUID after a
-- booking deletion is harmless — the lookup just returns None.
ALTER TABLE booking_drafts
    ADD COLUMN IF NOT EXISTS materialized_booking_id UUID;

CREATE INDEX IF NOT EXISTS idx_booking_drafts_materialized_booking_id
    ON booking_drafts (materialized_booking_id)
    WHERE materialized_booking_id IS NOT NULL;
