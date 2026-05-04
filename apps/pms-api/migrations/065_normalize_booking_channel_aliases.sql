-- Migration 065: Normalize booking.channel aliases (VAY-350)
--
-- Channex sends ``ota_name`` in inconsistent forms across properties
-- and account configs (``Booking.com``, ``booking_com``, ``BookingCom``,
-- ``booking``). The PMS Calendar legend / color map keys off the
-- canonical lowercase brand name (``booking.com``); rows stored under
-- any other alias rendered as gray "Other" instead of the dedicated
-- Booking.com color and logo.
--
-- New writes are normalized at the inbound boundary (see
-- ``app/channels.py`` + ``app/services/channex/inbound.py``); this
-- migration heals existing rows. ``channex`` is intentionally left
-- alone — when ``ota_name`` was missing on the original webhook we
-- can't retroactively recover the true OTA, and rewriting that bucket
-- would mis-color genuinely unknown sources.

UPDATE bookings
   SET channel = 'booking.com',
       updated_at = now()
 WHERE lower(channel) IN ('booking_com', 'bookingcom', 'booking', 'booking.com')
   AND channel <> 'booking.com';

UPDATE bookings
   SET channel = 'expedia',
       updated_at = now()
 WHERE lower(channel) IN ('expedia.com', 'expedia')
   AND channel <> 'expedia';

UPDATE bookings
   SET channel = 'hotels.com',
       updated_at = now()
 WHERE lower(channel) IN ('hotelscom', 'hotels.com')
   AND channel <> 'hotels.com';

-- Lowercase the remaining canonical singles so comparisons in the
-- frontend (which already lowercases) stay consistent.
UPDATE bookings
   SET channel = lower(channel),
       updated_at = now()
 WHERE channel <> lower(channel)
   AND lower(channel) IN ('direct', 'airbnb', 'agoda', 'vrbo',
                          'hostelworld', 'tripadvisor', 'channex', 'other');

-- Mirror the same heal for the channex booking mapping audit table —
-- ``channel_source`` is stored alongside each Channex booking link and
-- is also surfaced to operators in support flows.
UPDATE channex_booking_mappings
   SET channel_source = 'booking.com'
 WHERE lower(channel_source) IN ('booking_com', 'bookingcom', 'booking', 'booking.com')
   AND channel_source <> 'booking.com';
