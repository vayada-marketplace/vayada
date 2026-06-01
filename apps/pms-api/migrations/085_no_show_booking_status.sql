-- VAY-560: Add no_show booking status for guests who never arrived.

UPDATE bookings
SET status = 'cancelled'
WHERE status NOT IN (
    'pending',
    'confirmed',
    'checked_in',
    'in_house',
    'checked_out',
    'cancelled',
    'declined',
    'expired',
    'no_show'
);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'pending', 'confirmed', 'checked_in', 'in_house',
        'checked_out', 'cancelled', 'declined', 'expired', 'no_show'
    ));
