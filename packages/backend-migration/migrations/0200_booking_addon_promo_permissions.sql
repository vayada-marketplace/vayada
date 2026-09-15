-- VAY-1439: Separate Add-ons and Promos from general Booking Settings.
INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('booking.addons.read', 'booking', 'Read booking add-ons'),
  ('booking.addons.manage', 'booking', 'Manage booking add-ons'),
  ('booking.promos.read', 'booking', 'Read booking promo codes'),
  ('booking.promos.manage', 'booking', 'Manage booking promo codes');

-- Preserve capabilities of existing role defaults.
INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
SELECT existing.organization_kind, existing.role_key, permission.key
FROM identity.role_permission_grants existing
CROSS JOIN (VALUES ('booking.addons.read'), ('booking.addons.manage'),
                   ('booking.promos.read'), ('booking.promos.manage')) permission(key)
WHERE existing.permission_key = 'booking.settings.manage'
ON CONFLICT DO NOTHING;

-- Preserve existing explicit Settings grants/denials for these formerly shared
-- routes. Malformed overrides remain unchanged and fail closed at resolution.
CREATE FUNCTION pg_temp.expand_booking_settings_override(overrides JSONB)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(overrides->'grant') = 'array'
                   AND jsonb_typeof(overrides->'deny') = 'array'
    THEN CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(overrides->'grant')
                          GROUP BY value HAVING count(*) > 1)
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(overrides->'deny')
                               GROUP BY value HAVING count(*) > 1)
      THEN overrides
      ELSE overrides || jsonb_build_object(
      'grant', (SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM (
        SELECT value FROM jsonb_array_elements(overrides->'grant')
        UNION
        SELECT to_jsonb(key) FROM (VALUES ('booking.addons.read'), ('booking.addons.manage'),
          ('booking.promos.read'), ('booking.promos.manage')) added(key)
        WHERE overrides->'grant' ? 'booking.settings.manage'
      ) expanded),
      'deny', (SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM (
        SELECT value FROM jsonb_array_elements(overrides->'deny')
        UNION
        SELECT to_jsonb(key) FROM (VALUES ('booking.addons.read'), ('booking.addons.manage'),
          ('booking.promos.read'), ('booking.promos.manage')) added(key)
        WHERE overrides->'deny' ? 'booking.settings.manage'
      ) expanded)
    ) END ELSE overrides END
$$;

UPDATE identity.organization_memberships
SET permission_overrides = pg_temp.expand_booking_settings_override(permission_overrides),
    updated_at = now()
WHERE permission_overrides->'grant' ? 'booking.settings.manage'
   OR permission_overrides->'deny' ? 'booking.settings.manage';

UPDATE identity.staff_invitations
SET permission_overrides = pg_temp.expand_booking_settings_override(permission_overrides),
    updated_at = now()
WHERE permission_overrides->'grant' ? 'booking.settings.manage'
   OR permission_overrides->'deny' ? 'booking.settings.manage';
