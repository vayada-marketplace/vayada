-- VAY-965: isolated operational scan position, never serving authority.
CREATE TABLE platform.hotel_setup_reconciliation_cursors (
  mode TEXT PRIMARY KEY CHECK (mode IN ('organization', 'property')),
  scope_id UUID,
  organization_id UUID,
  actor_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_id IS NULL AND organization_id IS NULL AND actor_user_id IS NULL)
    OR (scope_id IS NOT NULL AND organization_id IS NOT NULL AND actor_user_id IS NOT NULL))
);
REVOKE ALL ON platform.hotel_setup_reconciliation_cursors FROM PUBLIC;
INSERT INTO platform.hotel_setup_reconciliation_cursors(mode) VALUES ('organization'), ('property');
