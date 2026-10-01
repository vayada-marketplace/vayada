import type { PermissionKey } from "@vayada/backend-auth";
import {
  hasActiveEntitlement,
  resolveEffectivePropertyAccess,
  resolveMembershipRolePermissions,
  type MembershipPropertyScope,
  type PropertyAccessContext,
} from "@vayada/backend-authorization";
import type { UpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import type { beginHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

/** Current membership, actor and base entitlement checks for the native currency scope.
 * beginHotelSetupCommandScope already locks the organization and canonical Owner links. */
export async function lockHotelSetupCurrencyMembership(
  client: Parameters<typeof beginHotelSetupCommandScope>[0],
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
  if (!resolved.ok || !resolved.permissions.includes("pms.operations.manage")) return false;
  const actor = await client.query(
    "SELECT id FROM identity.users WHERE id=$1::uuid AND status='active' FOR SHARE",
    [command.audit.actor.userId],
  );
  if (actor.rows.length !== 1) return false;
  const entitlements = await client.query<{
    key: string;
    status: "active" | "suspended" | "expired";
    resourceId: string | null;
    startsAt: Date | null;
    expiresAt: Date | null;
  }>(
    `SELECT entitlement_key AS key, status,
      CASE WHEN resource_product IS NULL THEN NULL ELSE resource_id::uuid::text END AS "resourceId",
      starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id=$1::uuid AND product='pms'
       AND entitlement_key IN ('property-management','pms-core','account_access')
       AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
         AND lower(resource_id)=$2::uuid::text))
     FOR SHARE`,
    [command.organizationId, command.propertyId],
  );
  // Read after all lock waits; now() and the request clock can predate revocation/expiry.
  const clock = await client.query<{ at: Date }>("SELECT pg_catalog.clock_timestamp() AS at");
  const at = clock.rows[0]?.at;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return false;
  return hasActiveEntitlement(
    {
      entitlements: entitlements.rows
        .filter((row) => row.startsAt === null || row.startsAt <= at)
        .map((row) => ({
          product: "pms" as const,
          key: row.key,
          status: row.expiresAt !== null && row.expiresAt <= at ? "expired" : row.status,
          ...(row.resourceId === null
            ? {}
            : {
                resource: {
                  product: "pms" as const,
                  resourceType: "pms_property" as const,
                  resourceId: row.resourceId,
                },
              }),
        })),
    },
    {
      product: "pms",
      key: "property-management",
      resource: { product: "pms", resourceType: "pms_property", resourceId: command.propertyId },
    },
  );
}
