-- Migration: 0541_pms_rooms_active_room_numbers
-- Owner: domain-pms / VAY-2467
--
-- A room number is taken only by a room that is still in use. Deleting a room in PMS, lowering a
-- room type's total rooms, or deleting or closing a room type retires the row and keeps its
-- room_number for history. Both uniqueness rules counted those retired rows, so a deleted room's
-- number stayed taken for good ("A room with this number already exists"). Both rules now skip
-- retired rooms. They keep their names, so next-api still answers operational_label_conflict.
-- Two rooms in use still can't share a number: exactly, and in any letter case once verified.
--
-- The new rules are looser, so existing rows always fit. In practice this is one-way: once a
-- deleted room's number is reused, the old rules can't be put back without renaming a room.

SET LOCAL lock_timeout = '5s';

ALTER TABLE pms.rooms
  DROP CONSTRAINT uq_pms_rooms_property_number;

CREATE UNIQUE INDEX uq_pms_rooms_property_number
  ON pms.rooms (property_id, room_number)
  WHERE status <> 'retired';

DROP INDEX pms.uq_pms_rooms_property_verified_label_ci;

CREATE UNIQUE INDEX uq_pms_rooms_property_verified_label_ci
  ON pms.rooms (property_id, lower(room_number))
  WHERE operational_label_status = 'verified'
    AND status <> 'retired';
