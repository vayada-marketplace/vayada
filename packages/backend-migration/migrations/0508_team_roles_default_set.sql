-- Migration: 0508_team_roles_default_set
-- Owner: identity / VAY-2276
-- See: packages/backend-auth/src/teamRoleCreate.ts (the "Delete role" command this cleanup copies)
--
-- 0203 gave every hotel account six roles: Account admin plus five ready-made ones. Hosts now create
-- their own staff roles, so the default set becomes Account admin, Property owner and Agency
-- manager: the only roles that carry the owner class and team management, which "Create role"
-- cannot make (Flamur, 2026-10-22).
--
-- 1. New accounts get those three. The trigger and its trigger function stay exactly as they are,
--    because the Channex worker's catalog digest hashes every trigger and trigger function on
--    identity.organizations. Only the function they call is replaced.
-- 2. Existing accounts lose each ready-made staff role (Reservation manager, Front desk,
--    Housekeeping) that the host never edited (revision 1) and that nobody uses: no member other
--    than inactive ones, and no pending invitation that is still valid. These are the "Delete role"
--    command's rules. Like it, 0508 first clears the role from inactive members and from
--    invitations that are no longer pending or have run out (those become expired), and writes one
--    identity.team_role.deleted audit event per role, with the deleted row and the memberships and
--    invitations it changed. Property owner, Agency manager, edited roles and roles in use stay.
--
-- The tables are locked before anything changes: no account can be created with the old function
-- body, and no member or invitation can pick up one of these roles between the check and the
-- delete. The foreign keys are NO ACTION, so a missed reference fails the migration instead of
-- dropping anyone's access.
--
-- Rollback: the audit events (audit_key 'team-role-cleanup-0508:<role id>') hold each deleted role
-- and the rows it was cleared from. Re-insert the roles from private_payload.previous and restore
-- role_definition_id on those memberships and invitations; restore the 0203 function body to seed
-- all six roles for new accounts again.

SET LOCAL lock_timeout = '5s';

LOCK TABLE identity.organizations, identity.organization_roles, identity.organization_memberships,
  identity.staff_invitations IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION identity.initialize_team_role_presets(organization UUID)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO identity.organization_roles
    (organization_id, name, description, security_class, base_role_key, preset_key, default_permissions)
  SELECT account.id, preset.* FROM identity.organizations account
  CROSS JOIN (VALUES
    ('Account admin', 'Full access to every property, every section and billing.', 'account_admin', 'hotel_owner', 'account_admin', '[]'::jsonb),
    ('Agency manager', 'Manages workers and properties within their own access. Cannot change billing or transfer admin.', 'staff', 'hotel_manager', 'agency_manager',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.dashboard.finance.read","pms.calendar.read","pms.calendar.manage","pms.reservation.read","pms.reservation.update","pms.reservation.cancel","pms.guest_contact.read","pms.inbox.read","pms.inbox.reply","pms.room_status.read","pms.rooms_rates.read","pms.rooms_rates.manage","pms.finance.read","pms.channel_manager.read","pms.settings.read","pms.settings.manage","identity.staff.manage","booking.analytics.read","booking.design.read","booking.design.manage","booking.flow.read","booking.flow.manage","booking.settings.read","booking.settings.manage","booking.addons.read","booking.addons.manage","booking.promos.read","booking.promos.manage"]'::jsonb),
    ('Property owner', 'Read-only performance and financial information for assigned properties.', 'external_owner', 'external_owner', 'property_owner',
     '["pms.dashboard.read","pms.dashboard.operations.read","pms.dashboard.finance.read","pms.calendar.read","pms.reservation.read","pms.room_status.read","pms.rooms_rates.read","pms.finance.read","booking.analytics.read"]'::jsonb)
  ) AS preset(name, description, security_class, base_role_key, preset_key, default_permissions)
  WHERE account.id = organization AND account.kind = 'hotel_group'
  ON CONFLICT (organization_id, preset_key) DO NOTHING;
$$;

CREATE TEMPORARY TABLE unused_staff_presets ON COMMIT DROP AS
  SELECT role.id, role.organization_id
  FROM identity.organization_roles role
  WHERE role.preset_key IN ('reservation_manager', 'front_desk', 'housekeeping')
    AND role.revision = 1
    AND NOT EXISTS (
      SELECT 1 FROM identity.organization_memberships member
      WHERE member.organization_id = role.organization_id AND member.role_definition_id = role.id
        AND member.status <> 'inactive')
    AND NOT EXISTS (
      SELECT 1 FROM identity.staff_invitations invite
      WHERE invite.organization_id = role.organization_id AND invite.role_definition_id = role.id
        AND invite.status = 'pending' AND (invite.expires_at IS NULL OR invite.expires_at > now()));

CREATE TEMPORARY TABLE cleared_role_links (role_id UUID, kind TEXT, row_id UUID, previous_status TEXT)
  ON COMMIT DROP;

WITH cleared AS (
  UPDATE identity.organization_memberships member
     SET role_definition_id = NULL
    FROM unused_staff_presets unused
   WHERE member.organization_id = unused.organization_id AND member.role_definition_id = unused.id
     AND member.status = 'inactive'
  RETURNING unused.id AS role_id, member.id AS row_id, member.status
)
INSERT INTO cleared_role_links SELECT role_id, 'membership', row_id, status FROM cleared;

WITH cleared AS (
  UPDATE identity.staff_invitations invite
     SET role_definition_id = NULL,
         status = CASE WHEN invite.status = 'pending' THEN 'expired' ELSE invite.status END
    FROM (
      SELECT old_invite.id, old_invite.status, unused.id AS role_id
      FROM identity.staff_invitations old_invite
      JOIN unused_staff_presets unused
        ON old_invite.organization_id = unused.organization_id AND old_invite.role_definition_id = unused.id
      WHERE old_invite.status <> 'pending' OR old_invite.expires_at <= now()
    ) previous
   WHERE invite.id = previous.id
  RETURNING previous.role_id, invite.id AS row_id, previous.status
)
INSERT INTO cleared_role_links SELECT role_id, 'invitation', row_id, status FROM cleared;

WITH deleted AS (
  DELETE FROM identity.organization_roles role
   USING unused_staff_presets unused
   WHERE role.organization_id = unused.organization_id AND role.id = unused.id
  RETURNING role.*
)
INSERT INTO platform.product_audit_events (
  audit_key, product, action, occurred_at, tenant_scope, organization_id, actor_type,
  target_resource_product, target_resource_type, target_resource_id,
  redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope
)
SELECT 'team-role-cleanup-0508:' || deleted.id::text, 'identity', 'identity.team_role.deleted', now(),
       'organization', deleted.organization_id, 'migration', 'identity', 'organization_role', deleted.id::text,
       jsonb_build_object('outcome', 'deleted', 'securityClass', deleted.security_class, 'presetKey', deleted.preset_key),
       jsonb_build_object(
         'previous', to_jsonb(deleted),
         'clearedMemberships', COALESCE((
           SELECT jsonb_agg(link.row_id ORDER BY link.row_id) FROM cleared_role_links link
           WHERE link.role_id = deleted.id AND link.kind = 'membership'), '[]'::jsonb),
         'clearedInvitations', COALESCE((
           SELECT jsonb_agg(jsonb_build_object('id', link.row_id, 'status', link.previous_status) ORDER BY link.row_id)
           FROM cleared_role_links link
           WHERE link.role_id = deleted.id AND link.kind = 'invitation'), '[]'::jsonb)),
       '{"migration":"0508","reason":"unused_staff_preset","ticket":"VAY-2276"}'::jsonb, 'security', 'confidential'
FROM deleted;
