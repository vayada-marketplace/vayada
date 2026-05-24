-- VAY-404: Distinguish host-rejected booking requests ("declined") from
-- guest-driven cancellations ("cancelled"). Previously host_reject_booking
-- stored 'cancelled' which was indistinguishable in the UI from a guest
-- withdrawing or cancelling their own booking.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'declined', 'expired'));
