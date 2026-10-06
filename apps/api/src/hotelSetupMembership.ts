import type { PermissionKey } from "@vayada/backend-auth";
import {
  resolveMembershipRolePermissions,
  resolveEffectivePropertyAccess,
  type MembershipPropertyScope,
  type PropertyAccessContext,
} from "@vayada/backend-authorization";
import type { beginHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

/** Call after native scope locks; all permission authority is reread on this client. */
export async function lockHotelSetupMembership(
  client: Parameters<typeof beginHotelSetupCommandScope>[0],
  command: { organizationId: string; actorUserId: string; propertyId?: string },
) {
  const members = await client.query<{
    id: string;
    roleKey: string;
    mode: string;
    accessOrigin: string;
    permissionOverrides: unknown;
    pms: boolean;
    booking: boolean;
    roleDefinitionId: string | null;
  }>(
    `SELECT id, role_key AS "roleKey", property_access_mode AS mode,
      access_origin AS "accessOrigin", permission_overrides AS "permissionOverrides",
      pms_access_enabled AS pms, booking_access_enabled AS booking,
      role_definition_id AS "roleDefinitionId"
     FROM identity.organization_memberships
     WHERE organization_id=$1::uuid AND user_id=$2::uuid AND status='active'
     FOR SHARE`,
    [command.organizationId, command.actorUserId],
  );
  if (members.rows.length !== 1) return null;
  const member = members.rows[0]!;
  if (typeof member.pms !== "boolean" || typeof member.booking !== "boolean") return null;
  const assignments = command.propertyId
    ? await client.query<{ propertyId: string }>(
        `SELECT property_id::text AS "propertyId" FROM identity.membership_property_assignments
     WHERE membership_id=$1::uuid AND property_id=$2::uuid FOR SHARE`,
        [member.id, command.propertyId],
      )
    : { rows: [] };
  const definitions = member.roleDefinitionId
    ? await client.query<NonNullable<MembershipPropertyScope["roleDefinition"]>>(
        `SELECT id, organization_id::text AS "organizationId",
          security_class AS "securityClass", base_role_key AS "baseRoleKey",
          preset_key AS "presetKey", default_permissions AS "defaultPermissions"
         FROM identity.organization_roles
         WHERE id=$1::uuid AND organization_id=$2::uuid FOR SHARE`,
        [member.roleDefinitionId, command.organizationId],
      )
    : null;
  const grants = await client.query<{ permission: PermissionKey }>(
    `SELECT permission_key AS permission FROM identity.role_permission_grants
     WHERE organization_kind='hotel_group' AND role_key=$1 ORDER BY permission_key FOR SHARE`,
    [member.roleKey],
  );
  const context: PropertyAccessContext = {
    actor: { internalUserId: command.actorUserId, status: "active" },
    selectedOrganization: {
      organizationId: command.organizationId,
      kind: "hotel_group",
      status: "active",
    },
    membership: { membershipId: member.id, roleKey: member.roleKey, status: "active" },
    // The native scope has already locked and proved this property's canonical Owner link.
    linkedResources: command.propertyId
      ? [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: command.propertyId,
            relationship: "owner",
            status: "active",
          },
        ]
      : [],
  };
  const scope: MembershipPropertyScope = {
    mode: member.mode,
    roleKey: member.roleKey,
    accessOrigin: member.accessOrigin,
    assignedPropertyIds: assignments.rows.map((row) => row.propertyId),
    permissionOverrides: member.permissionOverrides,
    productAccess: { pms: member.pms, booking: member.booking },
    roleDefinitionId: member.roleDefinitionId,
    roleDefinition: definitions?.rows[0] ?? null,
  };
  const resolved = resolveMembershipRolePermissions(
    context,
    grants.rows.map((row) => row.permission),
    scope,
  );
  if (!resolved.ok) return null;
  const actor = await client.query(
    "SELECT id FROM identity.users WHERE id=$1::uuid AND status='active' FOR SHARE",
    [command.actorUserId],
  );
  if (actor.rows.length !== 1) return null;
  return {
    context,
    scope,
    permissions: resolved.permissions.filter(
      (permission) =>
        (!permission.startsWith("pms.") || member.pms) &&
        (!permission.startsWith("booking.") || member.booking),
    ),
  };
}

export async function lockHotelSetupCreationPermissions(
  client: Parameters<typeof beginHotelSetupCommandScope>[0],
  command: { organizationId: string; actorUserId: string },
): Promise<readonly PermissionKey[] | null> {
  const membership = await lockHotelSetupMembership(client, command);
  if (
    !membership ||
    !(await resolveEffectivePropertyAccess(membership.context, {
      async findMembershipPropertyScope() {
        return membership.scope;
      },
    }))
  )
    return null;
  return membership.permissions.includes("hotel_catalog.setup.manage")
    ? membership.permissions
    : null;
}
