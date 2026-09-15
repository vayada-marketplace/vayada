import type pg from "pg";
import { parseStaffPermissionOverrides, validateStaffPermissionOverrides } from "./lifecycle.js";
import { resolveTeamRolePermissions, type TeamRolePolicy } from "./teamRolePolicy.js";

export type ManagedStaffAccess = {
  membershipId?: string;
  roleKey: string;
  isManagerRole?: boolean;
  accessOrigin: string;
  propertyAccessMode: "all" | "assigned";
  propertyIds: readonly string[];
  productAccess: { pms: boolean; booking: boolean };
  permissions: readonly string[];
};

// Caller holds the organization's mutation lock. This reads current saved access.
export async function loadManagedStaffAccess(
  client: pg.PoolClient,
  organizationId: string,
  membershipId: string,
): Promise<ManagedStaffAccess | null> {
  const result = await client.query<{
    id: string;
    role_key: string;
    access_origin: string;
    property_access_mode: "all" | "assigned";
    property_ids: string[];
    pms_access_enabled: boolean;
    booking_access_enabled: boolean;
    role_definition_id: string | null;
    definition: TeamRolePolicy | null;
    permission_overrides: unknown;
    permissions: string[];
    scope_valid: boolean;
  }>(
    `SELECT member.id, member.role_key, member.access_origin, member.property_access_mode,
            member.pms_access_enabled, member.booking_access_enabled, member.role_definition_id, member.permission_overrides,
            CASE WHEN role.id IS NULL THEN NULL ELSE jsonb_build_object('securityClass', role.security_class,
              'baseRoleKey', role.base_role_key, 'presetKey', role.preset_key, 'defaultPermissions', role.default_permissions) END AS definition,
            ARRAY(SELECT permission_key FROM identity.role_permission_grants WHERE organization_kind = 'hotel_group' AND role_key = member.role_key) AS permissions,
            ARRAY(SELECT property_id::text FROM identity.membership_property_assignments WHERE membership_id = member.id) AS property_ids,
            NOT EXISTS (SELECT 1 FROM identity.membership_property_assignments assignment WHERE assignment.membership_id = member.id
              AND NOT EXISTS (SELECT 1 FROM identity.organization_resource_links link WHERE link.organization_id = member.organization_id
                AND link.product = 'hotel_catalog' AND link.resource_type = 'property' AND link.resource_id = assignment.property_id::text
                AND link.relationship IN ('owner', 'operator') AND link.status = 'active')) AS scope_valid
     FROM identity.organization_memberships member LEFT JOIN identity.organization_roles role
       ON role.id = member.role_definition_id AND role.organization_id = member.organization_id
     WHERE member.organization_id = $1 AND member.id = $2 FOR UPDATE OF member`,
    [organizationId, membershipId],
  );
  const row = result.rows[0];
  if (!row || !row.scope_valid || !["all", "assigned"].includes(row.property_access_mode))
    return null;
  const overrides =
    row.permission_overrides === null
      ? { grant: [], deny: [] }
      : parseStaffPermissionOverrides(row.permission_overrides);
  if (!overrides) return null;
  let permissions: readonly string[] | null;
  if (row.role_definition_id !== null) {
    permissions =
      row.definition?.baseRoleKey === row.role_key
        ? resolveTeamRolePermissions(row.definition, overrides)
        : null;
    if (permissions && row.permissions.includes("hotel_catalog.property_manifest.read"))
      permissions = [...permissions, "hotel_catalog.property_manifest.read"];
  } else {
    const defaults = row.permissions.filter((key) => key !== "identity.staff.manage");
    if (
      validateStaffPermissionOverrides({
        roleKey: row.role_key,
        rolePermissions: defaults,
        permissionOverrides: overrides,
      }).length
    )
      return null;
    const effective = new Set(row.permissions);
    overrides.grant.forEach((key) => effective.add(key));
    overrides.deny.forEach((key) => effective.delete(key));
    permissions = [...effective];
  }
  return permissions
    ? {
        membershipId: row.id,
        roleKey: row.role_key,
        isManagerRole:
          row.role_key === "hotel_manager" &&
          (row.role_definition_id === null || row.definition?.presetKey === "agency_manager"),
        accessOrigin: row.access_origin,
        propertyAccessMode: row.property_access_mode,
        propertyIds: row.property_ids,
        productAccess: { pms: row.pms_access_enabled, booking: row.booking_access_enabled },
        permissions,
      }
    : null;
}

export function withinStaffManagementScope(
  manager: ManagedStaffAccess,
  worker: ManagedStaffAccess,
): boolean {
  if (
    manager.accessOrigin !== "agency" ||
    !manager.permissions.includes("identity.staff.manage") ||
    worker.accessOrigin !== "agency" ||
    (worker.membershipId && worker.membershipId === manager.membershipId) ||
    (worker.roleKey === "hotel_manager" && worker.isManagerRole !== false) ||
    ["hotel_owner", "external_owner", "owner", "operator"].includes(worker.roleKey) ||
    worker.permissions.some(
      (key) => key === "identity.staff.manage" || key === "finance.billing.manage",
    )
  )
    return false;
  if (
    (worker.productAccess.pms && !manager.productAccess.pms) ||
    (worker.productAccess.booking && !manager.productAccess.booking)
  )
    return false;
  if (
    manager.propertyAccessMode !== "all" &&
    (worker.propertyAccessMode === "all" ||
      worker.propertyIds.some((id) => !manager.propertyIds.includes(id)))
  )
    return false;
  const permissions = new Set(
    manager.permissions.filter(
      (key) =>
        (!key.startsWith("pms.") || manager.productAccess.pms) &&
        (!key.startsWith("booking.") || manager.productAccess.booking),
    ),
  );
  return worker.permissions.every((key) => permissions.has(key));
}
