import type { PoolClient } from "pg";
import type { StaffAccessTargetRow } from "./staffInvitations.js";
import { staffAccessRevision } from "./staffAccessRevision.js";
import { parseStaffPermissionOverrides } from "./lifecycle.js";
import { resolveTeamRolePermissions, type TeamRolePolicy } from "./teamRolePolicy.js";

type Member = StaffAccessTargetRow & { user_id: string; user_status: string };
type Role = TeamRolePolicy & { id: string; organizationId: string; revision: string };
export type AdminTransferSnapshot = {
  actor: Member & { revision: string };
  target: Member & { revision: string };
  adminRoleId: string;
  formerAdminRole: Role;
  propertyIds: string[];
};

/** Internal transaction read. The caller MUST hold an open transaction on this client
 * until proof consumption, both membership writes and audit commit/rollback.
 * Source-session verification belongs to the authenticated route before this call.
 */
export async function lockAdminTransferSnapshot(
  client: PoolClient,
  input: {
    organizationId: string;
    actorMembershipId: string;
    actorUserId: string;
    workosUserId: string;
    workosOrgId: string;
    targetMembershipId: string;
    formerAdminRoleId: string;
  },
): Promise<AdminTransferSnapshot | null> {
  if (input.actorMembershipId.toLowerCase() === input.targetMembershipId.toLowerCase()) return null;
  // Match ordinary staff writers: organization first, then member/user locks, then roles/properties.
  const org = await client.query(
    `SELECT id FROM identity.organizations
    WHERE id = $1 AND kind = 'hotel_group' AND status = 'active' AND workos_org_id = $2 FOR UPDATE`,
    [input.organizationId, input.workosOrgId],
  );
  if (!org.rowCount) return null;
  const owners = await client.query<{ id: string; role_key: string }>(
    `SELECT id, role_key FROM identity.organization_memberships
    WHERE organization_id = $1 AND role_key IN ('hotel_owner', 'owner', 'operator') ORDER BY id FOR UPDATE`,
    [input.organizationId],
  );
  if (
    owners.rowCount !== 1 ||
    owners.rows[0]?.role_key !== "hotel_owner" ||
    owners.rows[0].id !== input.actorMembershipId.toLowerCase()
  )
    return null;
  const members = await client.query<Member>(
    `SELECT m.*, m.updated_at::text AS updated_at, u.status AS user_status,
    CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.id, 'name', r.name, 'revision', r.revision::text, 'securityClass', r.security_class,
      'baseRoleKey', r.base_role_key, 'presetKey', r.preset_key, 'defaultPermissions', r.default_permissions) END AS role_definition,
    ARRAY(SELECT permission_key FROM identity.role_permission_grants WHERE organization_kind = 'hotel_group'
      AND role_key = m.role_key ORDER BY permission_key) AS role_permissions,
    ARRAY(SELECT property_id::text FROM identity.membership_property_assignments WHERE membership_id = m.id ORDER BY property_id) AS property_ids
    FROM identity.organization_memberships m JOIN identity.users u ON u.id = m.user_id
    LEFT JOIN identity.organization_roles r ON r.id = m.role_definition_id AND r.organization_id = m.organization_id
    WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[]) ORDER BY m.id FOR UPDATE OF m, u`,
    [input.organizationId, [input.actorMembershipId, input.targetMembershipId]],
  );
  const actor = members.rows.find((m) => m.id === input.actorMembershipId.toLowerCase());
  const target = members.rows.find((m) => m.id === input.targetMembershipId.toLowerCase());
  const actorOverrides =
    actor?.permission_overrides === null
      ? { grant: [], deny: [] }
      : parseStaffPermissionOverrides(actor?.permission_overrides);
  if (
    !actor ||
    !target ||
    actor.user_id !== input.actorUserId.toLowerCase() ||
    [actor, target].some((m) => m.status !== "active" || m.user_status !== "active") ||
    actor.access_origin !== "agency" ||
    actor.property_access_mode !== "all" ||
    !actor.pms_access_enabled ||
    !actor.booking_access_enabled ||
    !actor.role_permissions.includes("identity.staff.manage") ||
    !actorOverrides ||
    actorOverrides.grant.length !== 0 ||
    actorOverrides.deny.length !== 0 ||
    !["hotel_manager", "front_desk", "housekeeping", "hotel_custom", "external_owner"].includes(
      target.role_key,
    )
  )
    return null;
  const identity = await client.query(
    `SELECT id FROM identity.external_identities
    WHERE user_id = $1 AND provider = 'workos' AND provider_user_id = $2 FOR SHARE`,
    [input.actorUserId, input.workosUserId],
  );
  if (!identity.rowCount) return null;
  const roles = await client.query<Role>(
    `SELECT id, organization_id AS "organizationId", revision::text,
    security_class AS "securityClass", base_role_key AS "baseRoleKey", preset_key AS "presetKey", default_permissions AS "defaultPermissions"
    FROM identity.organization_roles WHERE organization_id = $1
      AND (id = $2 OR id = ANY($3::uuid[]) OR preset_key = 'account_admin') ORDER BY id FOR SHARE`,
    [
      input.organizationId,
      input.formerAdminRoleId,
      [actor.role_definition_id, target.role_definition_id].filter(Boolean),
    ],
  );
  const admin = roles.rows.find(
    (r) =>
      r.presetKey === "account_admin" &&
      r.securityClass === "account_admin" &&
      r.baseRoleKey === "hotel_owner" &&
      Array.isArray(r.defaultPermissions) &&
      r.defaultPermissions.length === 0,
  );
  const former = roles.rows.find((r) => r.id === input.formerAdminRoleId.toLowerCase());
  if (
    !admin ||
    !former ||
    (actor.role_definition_id !== null && actor.role_definition_id !== admin.id)
  )
    return null;
  if (target.role_definition_id !== null) {
    const targetRole = roles.rows.find((r) => r.id === target.role_definition_id);
    if (
      !targetRole ||
      targetRole.baseRoleKey !== target.role_key ||
      resolveTeamRolePermissions(targetRole, target.permission_overrides) === null
    )
      return null;
  }
  const edges = await client.query<{
    subject_membership_id: string;
    delegator_membership_id: string;
  }>(
    `SELECT subject_membership_id, delegator_membership_id
    FROM identity.membership_delegations WHERE organization_id = $1
      AND (subject_membership_id = ANY($2::uuid[]) OR delegator_membership_id = $3) FOR UPDATE`,
    [input.organizationId, [actor.id, target.id], target.id],
  );
  if (
    edges.rows.some(
      (e) => e.subject_membership_id === actor.id || e.delegator_membership_id === target.id,
    )
  )
    return null;
  const subjectEdges = edges.rows.filter((e) => e.subject_membership_id === target.id).length;
  if (
    (target.access_origin === "agency" && subjectEdges !== 0) ||
    (target.access_origin === "external_owner" && subjectEdges !== 1) ||
    !["agency", "external_owner"].includes(target.access_origin)
  )
    return null;
  await client.query(
    "SELECT membership_id FROM identity.membership_property_assignments WHERE membership_id = ANY($1::uuid[]) FOR UPDATE",
    [[actor.id, target.id]],
  );
  const properties = await client.query<{ id: string }>(
    `SELECT p.id FROM identity.organization_resource_links l
    JOIN hotel_catalog.properties p ON p.id::text = l.resource_id
    WHERE l.organization_id = $1 AND l.product = 'hotel_catalog' AND l.resource_type = 'property'
      AND l.relationship IN ('owner', 'operator') AND l.status = 'active' FOR SHARE OF l, p`,
    [input.organizationId],
  );
  return {
    actor: { ...actor, revision: staffAccessRevision(actor) },
    target: { ...target, revision: staffAccessRevision(target) },
    adminRoleId: admin.id,
    formerAdminRole: former,
    propertyIds: [...new Set(properties.rows.map((p) => p.id))].sort(),
  };
}
