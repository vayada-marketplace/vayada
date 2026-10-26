-- VAY-2272 (Marketplace removal step 5, W1). HOLD: merge only with Flamur's yes, after the
-- counts-0497 before-run.
--
-- The affiliate click capture never went live, and no code calls it any more. This retires its
-- guard in the shared tables: the two lock-only policies, the booking creation xid column and its
-- trigger, and the five capture, admission and binding functions. The affiliate tables themselves
-- go with 0498.
--
-- hotel_catalog.property_slugs keeps row level security: 0429's pricing_runtime_slug_lock_only is
-- RESTRICTIVE and needs a permissive policy beside it, or every login that does not own the table
-- loses access (0474). The permissive one stays, under a name that no longer says affiliate.
--
-- Rollback: any image at or after f027728cc (no code reads the dropped objects).
SET LOCAL lock_timeout = '5s';

LOCK TABLE
  booking.guest_bookings,
  hotel_catalog.properties,
  hotel_catalog.property_slugs
  IN ACCESS EXCLUSIVE MODE;

ALTER POLICY affiliate_capture_compat ON hotel_catalog.property_slugs
  RENAME TO property_slugs_existing_access;
DROP POLICY affiliate_capture_destination_lock_only ON hotel_catalog.property_slugs;
DROP POLICY affiliate_capture_destination_lock_only ON hotel_catalog.properties;

DROP TRIGGER guest_bookings_affiliate_creation_xid_no_update ON booking.guest_bookings;
ALTER TABLE booking.guest_bookings DROP COLUMN affiliate_binding_created_xid;

DROP FUNCTION
  booking.reject_affiliate_booking_creation_xid_mutation(),
  booking.bind_live_affiliate_original(uuid, uuid),
  booking.admit_affiliate_click(text, uuid, uuid),
  marketplace.capture_affiliate_click(text, text, text),
  marketplace.consume_affiliate_click_quota(text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy policy
    WHERE policy.polname LIKE 'affiliate_capture%'
  ) THEN
    RAISE EXCEPTION 'An affiliate capture policy remains';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'hotel_catalog.property_slugs'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy policy
       WHERE policy.polrelid = 'hotel_catalog.property_slugs'::regclass
         AND policy.polpermissive
         AND policy.polcmd IN ('r', '*'))
  THEN
    RAISE EXCEPTION 'hotel_catalog.property_slugs lost row level security or its permissive read policy';
  END IF;
END $$;
