-- Migration 072: allow one Channex booking to map to N PMS bookings.
--
-- Channex delivers multi-room OTA reservations (e.g. Booking.com "2 rooms,
-- one reservation") as a single revision with a `rooms[]` array of length N.
-- Each entry is one room the guest paid for. Before this migration the
-- import path took rooms[0] and dropped the rest, leaving the property open
-- to silent double-bookings (VAY-392). The dedupe index on
-- (hotel_id, channex_booking_id) also blocked the fix: we could not insert
-- a second mapping row for the same Channex booking.
--
-- Add a per-room slot column and key the uniqueness off (hotel, channex
-- booking, slot index) so each room in the OTA reservation gets its own
-- PMS booking row, linked back to the same Channex booking ID.

ALTER TABLE channex_booking_mappings
    ADD COLUMN channex_room_index INT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_channex_booking_mappings_hotel_channex;
CREATE UNIQUE INDEX idx_channex_booking_mappings_hotel_channex_slot
    ON channex_booking_mappings(hotel_id, channex_booking_id, channex_room_index);
