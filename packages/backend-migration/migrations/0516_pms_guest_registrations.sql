-- Migration: 0516_pms_guest_registrations
-- Owner: domain-pms / VAY-2373
--
-- What staff record about each guest at check-in, for police registration: date of birth, identity document,
-- gender, which room they sleep in and a staff-only note. One row per booking guest (the booker or an additional
-- guest in booking.booking_guests); names, email, phone and nationality stay on that guest row.
--
-- Staff-only: guests never read it, and next-api hides the ID fields from staff without guest contact access.
-- Kept like the other guest details (Flamur, 2026-10-26, D1 A): the row goes with its guest or booking; deleting
-- the ID fields some months after check-out is a follow-up.
--
-- The room is the booked room's assignment. An OTA change that drops that room clears it, as for check-in records.
-- No foreign key to identity.users: the editor is in the audit event, and identity FKs are pinned (0500).

CREATE TABLE pms.guest_registrations (
  booking_guest_id    UUID        PRIMARY KEY REFERENCES booking.booking_guests(id) ON DELETE CASCADE,
  property_id         UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  guest_booking_id    UUID        NOT NULL,
  assignment_id       UUID,
  date_of_birth       DATE,
  document_type       TEXT        CHECK (document_type IN ('passport', 'national_id', 'driving_licence', 'other')),
  document_number     TEXT        CHECK (document_number IS NULL OR char_length(document_number) BETWEEN 1 AND 64),
  gender              TEXT        CHECK (gender IN ('female', 'male', 'other', 'prefer_not_to_say')),
  staff_notes         TEXT        CHECK (staff_notes IS NULL OR char_length(staff_notes) BETWEEN 1 AND 2000),
  updated_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_pms_guest_registrations_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_guest_registrations_assignment_property
    FOREIGN KEY (assignment_id, property_id, guest_booking_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, guest_booking_id)
    ON DELETE SET NULL (assignment_id),
  CONSTRAINT chk_pms_guest_registrations_birth_date
    CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2100-01-01')
);

CREATE INDEX idx_pms_guest_registrations_booking
  ON pms.guest_registrations (property_id, guest_booking_id);

COMMENT ON TABLE pms.guest_registrations IS
  'VAY-2373: staff-recorded registration details per booking guest (ID document, date of birth, gender, room, staff note).';
