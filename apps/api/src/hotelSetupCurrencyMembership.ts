import type { PermissionKey } from "@vayada/backend-auth";
import {
  resolveEffectivePropertyAccess,
  resolveMembershipRolePermissions,
  type MembershipPropertyScope,
  type PropertyAccessContext,
} from "@vayada/backend-authorization";
import type { UpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import type { PmsPricingCommandClient } from "./domains/pmsPricingCommandRepository.js";

/** Additional live membership veto for a transaction already bound by beginHotelSetupCommandScope.
 * Owner, actor, organization and entitlement locks remain in the currency repository. */
export async function lockHotelSetupCurrencyMembership(
  client: PmsPricingCommandClient,
  command: Pick<UpsertPropertyPricingCurrencyCommand, "organizationId" | "propertyId" | "audit">,
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
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
    [command.organizationId, command.audit.actor.userId],
  );
  if (members.rows.length !== 1) return false;
  const member = members.rows[0]!;
  if (!member.pms || typeof member.booking !== "boolean") return false;
  const assignments = await client.query<{ propertyId: string }>(
    `SELECT property_id::text AS "propertyId" FROM identity.membership_property_assignments
     WHERE membership_id=$1::uuid AND property_id=$2::uuid FOR SHARE`,
    [member.id, command.propertyId],
  );
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
    actor: { internalUserId: command.audit.actor.userId, status: "active" },
    selectedOrganization: {
      organizationId: command.organizationId,
      kind: "hotel_group",
      status: "active",
    },
    membership: { membershipId: member.id, roleKey: member.roleKey, status: "active" },
    // The native scope has already locked and proved this property's canonical Owner link.
    linkedResources: [
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: command.propertyId,
        relationship: "owner",
        status: "active",
      },
    ],
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
  const access = await resolveEffectivePropertyAccess(context, {
    async findMembershipPropertyScope() {
      return scope;
    },
  });
  if (!access?.propertyIds.includes(command.propertyId)) return false;
  const resolved = resolveMembershipRolePermissions(
    context,
    grants.rows.map((row) => row.permission),
    scope,
  );
  return resolved.ok && resolved.permissions.includes("pms.operations.manage");
}
