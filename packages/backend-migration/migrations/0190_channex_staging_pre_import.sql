-- VAY-2013: immutable, exact staging evidence may precede the canonical booking.
-- Existing non-null references retain their property-scoped FK and repair semantics.
ALTER TABLE pms.channex_staging_catalog_references
  ALTER COLUMN guest_booking_id DROP NOT NULL;
