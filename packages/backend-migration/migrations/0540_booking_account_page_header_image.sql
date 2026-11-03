-- Migration: 0540_booking_account_page_header_image
-- Owner: platform-media, domain-booking / VAY-2457
--
-- The agency booking page's own header image (VAY-2450 C2): a new platform-media purpose,
-- 'booking.account_page.header_image', public only like the hotel header logo, and the page's
-- reference to it. The media belongs to the account: its target resource is the account's booking
-- page (resource_product 'booking', resource_type 'account_booking_page', resource_id the account),
-- owner_organization_id the account, no property. NULL keeps the photo of the stay the design comes
-- from. Deleting the media clears the reference.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose IN ('booking.header_logo', 'booking.account_page.header_image')
      THEN media_visibility = 'public'
    WHEN media_purpose IN (
      'identity.user.profile_image',
      'booking.addon.image',
      'property.hero_image',
      'property.gallery_image',
      'property.logo',
      'marketplace.offer.media',
      'marketplace.creator.profile_image',
      'pms.room_type.media'
    ) THEN media_visibility IN ('public', 'private')
    WHEN media_purpose IN (
      'marketplace.collaboration_chat.attachment',
      'pms.messaging.attachment',
      'pms.import.source_image',
      'finance.expense.receipt',
      'finance.financials_export'
    ) THEN media_visibility = 'private'
    ELSE FALSE
  END;
$$;

ALTER TABLE booking.account_booking_pages
  ADD COLUMN header_image_media_object_id UUID
    CONSTRAINT fk_account_booking_pages_header_image
    REFERENCES platform.media_objects(id) ON DELETE SET NULL;

COMMENT ON COLUMN booking.account_booking_pages.header_image_media_object_id IS
  'The agency page''s own header image (purpose booking.account_page.header_image). NULL: the photo of the stay the design comes from.';
