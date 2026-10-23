-- Migration: 0510_booking_design_readable_primary_color
-- Owner: domain-booking / VAY-2318
--
-- The booking page takes its colour from the booking design revision. Design Studio now writes it
-- too, so the revision takes any uppercase #RRGGBB instead of only the setup step's five swatches.
-- The domain (isBookingDesignPrimaryColor) still refuses colours whose button would not keep white
-- text readable (WCAG AA 4.5:1). Every existing row is one of the five swatches and passes.

ALTER TABLE booking.booking_design_revisions
DROP CONSTRAINT chk_booking_design_primary_color;

ALTER TABLE booking.booking_design_revisions
ADD CONSTRAINT chk_booking_design_primary_color
CHECK (primary_color ~ '^#[0-9A-F]{6}$');
