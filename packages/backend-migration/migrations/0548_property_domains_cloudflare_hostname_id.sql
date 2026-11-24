-- Migration: 0548_property_domains_cloudflare_hostname_id
-- Owner: hotel-catalog, domain-booking / VAY-2580
--
-- The Cloudflare for SaaS custom hostname that next-api's domain check registered for this domain.
-- When the hotel removes or replaces the domain, next-api deletes that hostname and no other. NULL
-- means next-api didn't register it: the old booking-api's hostnames share the vayada.com zone, and
-- its pages may still use them. Saving the same domain again keeps the id.

SET LOCAL lock_timeout = '5s';

ALTER TABLE hotel_catalog.property_domains
  ADD COLUMN cloudflare_hostname_id TEXT
    CONSTRAINT chk_property_domains_cloudflare_hostname_id
    CHECK (cloudflare_hostname_id IS NULL OR cloudflare_hostname_id ~ '^[A-Za-z0-9-]{1,64}$');
