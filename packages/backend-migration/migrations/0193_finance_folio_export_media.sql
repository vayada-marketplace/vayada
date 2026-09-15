-- Migration: 0193_finance_folio_export_media
-- Owner: platform-media, domain-finance / VAY-1134

CREATE OR REPLACE FUNCTION platform.valid_media_purpose_visibility(
  media_purpose TEXT,
  media_visibility TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN media_purpose = 'booking.header_logo'
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

ALTER TABLE platform.media_objects
  DROP CONSTRAINT chk_platform_media_objects_finance_expense_receipt,
  ADD CONSTRAINT chk_platform_media_objects_finance
    CHECK (
      (resource_product <> 'finance' AND purpose NOT IN ('finance.expense.receipt', 'finance.financials_export'))
      OR (purpose = 'finance.expense.receipt' AND resource_product = 'finance' AND resource_type = 'expense' AND property_id IS NOT NULL)
      OR (purpose = 'finance.financials_export' AND resource_product = 'finance' AND resource_type = 'financials_export' AND property_id IS NOT NULL AND owner_organization_id IS NOT NULL AND retained_until IS NOT NULL)
    ) NOT VALID;
