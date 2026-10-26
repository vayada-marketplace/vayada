-- Migration: 0517_pms_checkin_settings
-- Owner: domain-pms / VAY-2374
--
-- How each property runs the step-by-step check-in (Settings → Check-in): the special request, room changes,
-- who registers and which guest fields are shown or required, the add-ons sold at the desk, how a balance can
-- be settled, and the key handover. The extra checks stay in pms.checkin_checklist_templates.
--
-- One JSON object per property, validated by next-api; keys it doesn't hold fall back to the defaults, so a new
-- setting needs no migration. No row means the defaults, so every property is unchanged at release.
-- No foreign key to identity.users: the editor is in the audit event, and identity FKs are pinned (0500).

CREATE TABLE pms.checkin_settings (
  property_id         UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  settings            JSONB       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pms.checkin_settings IS
  'VAY-2374: per-property settings for the step-by-step check-in. No row: the defaults.';
