-- VAY-2247 1.5: a hotel's profile is complete when its basics are there: name, property type,
-- street, city, country, time zone, and an email and a phone contact (application side since
-- VAY-2247 1.4a; photos and a description are optional). This marks the hotels whose basics are
-- there but whose stored status still says incomplete under the old description-and-photo rule.
-- It only promotes: no hotel is marked incomplete and no hotel goes live (setup does that at the
-- end of the first run or with "Present your hotel"). Disabled and private hotels never change.
-- Running it again finds nothing.
SET LOCAL lock_timeout = '5s';

UPDATE hotel_catalog.properties property
SET profile_status = 'complete',
    completeness_reasons = '{}',
    updated_at = now()
WHERE property.profile_status = 'incomplete'
  AND NULLIF(property.display_name, '') IS NOT NULL
  AND NULLIF(property.property_type, '') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM hotel_catalog.property_locations location
    WHERE location.property_id = property.id
      AND NULLIF(location.street_address, '') IS NOT NULL
      AND NULLIF(location.city, '') IS NOT NULL
      AND NULLIF(location.country_code::text, '') IS NOT NULL
      AND NULLIF(location.timezone, '') IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id = property.id AND contact.channel_type = 'email'
      AND NULLIF(contact.value, '') IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id = property.id AND contact.channel_type = 'phone'
      AND NULLIF(contact.value, '') IS NOT NULL
  );
