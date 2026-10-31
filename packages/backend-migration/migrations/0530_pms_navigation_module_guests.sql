-- Migration: 0530_pms_navigation_module_guests
-- Owner: domain-pms / VAY-2423
--
-- Guests joins the PMS Feature Hub switches. Unlike Inbox and Reviews, Guests is on by default:
-- the API reads a property without a guests row as on, so nothing is backfilled. Like the other
-- switches it only decides what the PMS shows; guest records keep being linked and kept.

SET LOCAL lock_timeout = '5s';

ALTER TABLE pms.property_navigation_modules
  DROP CONSTRAINT property_navigation_modules_module_id_check,
  ADD CONSTRAINT property_navigation_modules_module_id_check
    CHECK (module_id IN ('inbox', 'reviews', 'guests'));
