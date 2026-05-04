-- Migration 064: Clamp negative channex_channel_markups to 0 (VAY-349)
--
-- The markup_pct column was originally validated against [-50, 200] which
-- allowed a hotel admin to silently apply a *discount* to OTA rates by
-- setting a negative value. That broke 1:1 rate parity between the direct
-- price and the price pushed via Channex (e.g. 3,000,000 IDR set in the
-- system arrived as 2,626,500 IDR on Booking.com when markup_pct was set
-- to roughly -12.45). Markups are now constrained to >= 0 in the API
-- model (app/models/channex.py); this migration retroactively heals any
-- existing row that was below zero.

UPDATE channex_channel_markups
   SET markup_pct = 0,
       updated_at = now()
 WHERE markup_pct < 0;
