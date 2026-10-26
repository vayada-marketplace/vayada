import type { PermissionKey } from "@vayada/backend-auth";
import {
  resolveMembershipRolePermissions,
  type MembershipPropertyScope,
} from "@vayada/backend-authorization";
import type { QueryResult, QueryResultRow } from "pg";

type MemberPermissionClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
};

/** A hotel member's effective permissions, resolved like the routes resolve them: role grants,
 * team-role definition, permission overrides and the PMS/Booking switches (VAY-2335). With a
 * propertyId it also requires access to that property, for callers no route checked first.
 * Locks the rows it reads unless readOnly. Null when the membership is gone or invalid. */
export async function lockMemberPermissions(
  client: MemberPermissionClient,
  member: { organizationId: string; actorUserId: string },
  options: { readOnly?: boolean; propertyId?: string } = {},
): Promise<readonly PermissionKey[] | null> {
  const lock = options.readOnly ? "" : " FOR SHARE";
  const members = await client.query<{
    id: string;
    roleKey: string;
    mode: string;
    accessOrigin: string;
    permissionOverrides: unknown;
    roleDefinitionId: string | null;
    pms: boolean;
    booking: boolean;
  }>(
    `SELECT id, role_key AS "roleKey", property_access_mode AS mode,
       access_origin AS "accessOrigin", permission_overrides AS "permissionOverrides",
       role_definition_id AS "roleDefinitionId",
       pms_access_enabled AS pms, booking_access_enabled AS booking
     FROM identity.organization_memberships
     WHERE organization_id = $1::uuid AND user_id = $2::uuid AND status = 'active'${lock}`,
    [member.organizationId, member.actorUserId],
  );
  if (members.rows.length !== 1) return null;
  const membership = members.rows[0]!;
  if (
    typeof membership.pms !== "boolean" ||
    typeof membership.booking !== "boolean" ||
    membership.accessOrigin !== "agency" ||
    (membership.mode !== "all" && membership.mode !== "assigned") ||
    (membership.roleKey === "external_owner" && membership.mode !== "assigned")
  )
    return null;
  if (options.propertyId && membership.mode === "assigned") {
    const assignment = await client.query(
      `SELECT property_id FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid${lock}`,
      [membership.id, options.propertyId],
    );
    if (assignment.rows.length !== 1) return null;
  }
  const definitions = membership.roleDefinitionId
    ? await client.query<NonNullable<MembershipPropertyScope["roleDefinition"]>>(
        `SELECT id, organization_id::text AS "organizationId",
           security_class AS "securityClass", base_role_key AS "baseRoleKey",
           preset_key AS "presetKey", default_permissions AS "defaultPermissions"
         FROM identity.organization_roles
         WHERE id = $1::uuid AND organization_id = $2::uuid${lock}`,
        [membership.roleDefinitionId, member.organizationId],
      )
    : null;
  const grants = await client.query<{ permission: PermissionKey }>(
    `SELECT permission_key AS permission FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1
     ORDER BY permission_key${options.readOnly ? "" : " FOR KEY SHARE"}`,
    [membership.roleKey],
  );
  const resolved = resolveMembershipRolePermissions(
    {
      selectedOrganization: {
        organizationId: member.organizationId,
        kind: "hotel_group",
        status: "active",
      },
      membership: { membershipId: membership.id, roleKey: membership.roleKey, status: "active" },
    },
    grants.rows.map((row) => row.permission),
    {
      mode: membership.mode,
      roleKey: membership.roleKey,
      accessOrigin: membership.accessOrigin,
      assignedPropertyIds: [],
      permissionOverrides: membership.permissionOverrides,
      roleDefinitionId: membership.roleDefinitionId,
      roleDefinition: definitions?.rows[0] ?? null,
    },
  );
  if (!resolved.ok) return null;
  return resolved.permissions.filter(
    (permission) =>
      (!permission.startsWith("pms.") || membership.pms) &&
      (!permission.startsWith("booking.") || membership.booking),
  );
}
