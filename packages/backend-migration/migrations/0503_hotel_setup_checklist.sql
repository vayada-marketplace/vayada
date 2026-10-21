-- Migration: 0503_hotel_setup_checklist
-- Owner: domain-hotels (setup checklist)
-- See: VAY-2247 wave 2 (hotel-setup-checklist.v1, packages/domain-hotels/src/hotelSetupChecklist.ts)
--
-- The setup checklist works out almost everything from what the hotel already has. It remembers two things:
-- 1. "Looks good" on calendar and guest terms: the owner keeps setup's defaults. One row per hotel and item;
--    a later "Looks good" by someone else replaces who and when.
-- 2. Each person's own view of a hotel's checklist: "Hide for now" and, once everything is done, "Dismiss".
-- Both are additive: nothing existing changes, and no data is copied.
SET LOCAL lock_timeout = '5s';

CREATE TABLE hotel_catalog.setup_checklist_acknowledgements (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  item TEXT NOT NULL CHECK (item IN ('calendar', 'guest_terms')),
  acknowledged_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, item)
);

CREATE TABLE hotel_catalog.setup_checklist_viewer_states (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, user_id)
);

COMMENT ON TABLE hotel_catalog.setup_checklist_acknowledgements IS
  'VAY-2247: "Looks good" on a setup checklist item (calendar, guest terms): the hotel keeps setup''s defaults.';
COMMENT ON TABLE hotel_catalog.setup_checklist_viewer_states IS
  'VAY-2247: one person''s view of a hotel''s setup checklist: hidden for now, or dismissed once done.';
