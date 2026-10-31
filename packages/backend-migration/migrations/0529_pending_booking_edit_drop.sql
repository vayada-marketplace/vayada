-- Migration: 0529_pending_booking_edit_drop
-- Owner: booking / VAY-2429 (PR 2). HOLD: merge only with Flamur's yes, timed by the coordinator.
--
-- Drops what 0154, 0155 and 0163 built for the guest "Edit request" flow. VAY-2400 (#3920) removed the
-- flow, and VAY-2429 PR 1 (#3929) removed its last, already uncalled reader. Gone: the views
-- pms.pending_booking_edit_support and pms.pending_booking_edit_receipts, and the tables
-- booking.pending_booking_edit_attempts and booking.edit_authorization_releases, with every row. This
-- replaces 0154's pointer to engineering/pending-booking-edit-contract.md, which #3920 deleted.
--
-- Kept from 0154 because they are live: edit_revision on booking.guest_bookings and
-- booking.booking_addon_selections, booking.protect_addon_edit_revision() with its trigger,
-- booking.active_booking_addon_selections and booking.guest_bookings.active_card_payment_id.
-- Pricing-v2 date changes and add-on revenue use them.
--
-- Decision (Flamur, 2026-10-31): drop the rows too. Production that day held 4 attempts, all closed
-- (none prepared or release_pending), and no authorization releases. The gate refuses only while an
-- attempt is open or a card authorization is not yet released.
-- Rollback: any image at or after ed135f46b (#3920). From there on nothing calls code that reads or
-- writes these objects. The dropped rows are gone and no rollback restores them.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The views go first. DROP VIEW locks only the view, and a reader locks a view before its tables, so
-- dropping them after the table lock below could deadlock with one. 0163 defines the support view on
-- the receipts view. A refused gate rolls these back too.
DROP VIEW pms.pending_booking_edit_support;
DROP VIEW pms.pending_booking_edit_receipts;

-- The dropped tables and every table one of them references (dropping a foreign key removes its
-- triggers there), in one statement and one order.
LOCK TABLE
  booking.edit_authorization_releases, booking.guest_bookings, booking.pending_booking_edit_attempts,
  booking.quote_sessions, finance.payment_provider_accounts, hotel_catalog.properties
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.pending_booking_edit_attempts
             WHERE status IN ('prepared', 'release_pending')) THEN
    RAISE EXCEPTION 'Pending booking edit attempts still open';
  END IF;
  IF EXISTS (SELECT 1 FROM booking.edit_authorization_releases WHERE released_at IS NULL) THEN
    RAISE EXCEPTION 'Edit card authorizations not yet released';
  END IF;
END $$;

DROP TABLE booking.pending_booking_edit_attempts, booking.edit_authorization_releases;
