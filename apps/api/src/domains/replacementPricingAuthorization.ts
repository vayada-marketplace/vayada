import { parseStaffPermissionOverrides, validateStaffPermissionOverrides, type RequestContext } from "@vayada/backend-auth";
import { hasActiveEntitlement, hasActiveLinkedResource, hasPermission } from "@vayada/backend-authorization";
import type { PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import type { PricingStorageScope } from "./replacementPricingStore.js";

/** Call within the pricing transaction, before owner-source reads. Context must come from
 * authentication/route policy, never request JSON. This is identity authorization only. */
export async function lockReplacementPricingAuthorization(
  client: PoolClient, context: RequestContext | null, scope: PricingStorageScope,
  operation: "read" | "manage",
): Promise<boolean> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!context || ![scope.propertyId, scope.organizationId, scope.actorUserId, context.membership.membershipId].every((id) => uuid.test(id)) ||
      context.actor.internalUserId.toLowerCase() !== scope.actorUserId.toLowerCase() ||
      context.selectedOrganization.organizationId.toLowerCase() !== scope.organizationId.toLowerCase() ||
      context.actor.status !== "active" || context.selectedOrganization.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group" || context.membership.status !== "active" ||
      !["read", "manage"].includes(operation)) return false;
  const propertyId = scope.propertyId.toLowerCase();
  const permission = operation === "read" ? "pms.rooms_rates.read" : "pms.rooms_rates.manage";
  const resource = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
  if (!hasPermission(context, permission) ||
      !hasActiveLinkedResource(context, { ...resource, allowedRelationships: ["owner", "operator"] }) ||
      !hasActiveEntitlement(context, { product: "pms", key: "property-management", resource })) return false;
  await lockPmsInventoryMutationScope(client, propertyId);
  // UPDATE locks also serialize FK-backed entitlement inserts (including new suspensions).
  const organization = await client.query(`SELECT id FROM identity.organizations
    WHERE id=$1 AND kind='hotel_group' AND status='active' FOR UPDATE`, [scope.organizationId]);
  if (!organization.rowCount) return false;
  const result = await client.query(`SELECT m.role_key,m.property_access_mode,m.permission_overrides
    FROM identity.organization_memberships m
    JOIN identity.users u ON u.id=m.user_id AND u.status='active'
    JOIN hotel_catalog.properties p ON p.id=$4 AND p.profile_status<>'disabled'
    WHERE m.id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND m.status='active'
      AND m.access_origin='agency'
    FOR SHARE OF m,u,p`, [context.membership.membershipId, scope.organizationId, scope.actorUserId, propertyId]);
  const membership = result.rows[0];
  if (!membership || membership.role_key !== context.membership.roleKey ||
      !["all", "assigned"].includes(membership.property_access_mode) ||
      (membership.role_key === "external_owner" && membership.property_access_mode !== "assigned")) return false;
  const links = (await client.query(`SELECT product,resource_type FROM identity.organization_resource_links
    WHERE organization_id=$1 AND resource_id=$2 AND status='active' AND relationship IN ('owner','operator')
      AND ((product='pms' AND resource_type='pms_property') OR (product='hotel_catalog' AND resource_type='property'))
    FOR SHARE`, [scope.organizationId, propertyId])).rows;
  if (!links.some((l) => l.product === "pms") || !links.some((l) => l.product === "hotel_catalog")) return false;
  if (membership.property_access_mode === "assigned") {
    const assignment = await client.query(`SELECT property_id FROM identity.membership_property_assignments
      WHERE membership_id=$1 AND property_id=$2 FOR SHARE`, [context.membership.membershipId, propertyId]);
    if (!assignment.rowCount) return false;
  }
  const rolePermissions = (await client.query(`SELECT permission_key FROM identity.role_permission_grants
    WHERE organization_kind='hotel_group' AND role_key=$1 FOR SHARE`, [membership.role_key])).rows.map((r) => r.permission_key as string);
  const permissions = new Set(rolePermissions);
  if (membership.permission_overrides !== null) {
    const overrides = parseStaffPermissionOverrides(membership.permission_overrides);
    if (!overrides || validateStaffPermissionOverrides({ roleKey: membership.role_key, rolePermissions, permissionOverrides: overrides }).length) return false;
    for (const key of overrides.grant) permissions.add(key);
    for (const key of overrides.deny) permissions.delete(key);
  }
  if (!permissions.has(permission)) return false;
  // Lock even currently unrelated rows: an update could retarget one as a scoped suspension.
  const entitlements = (await client.query(`SELECT * FROM identity.product_entitlements
    WHERE organization_id=$1 FOR SHARE`, [scope.organizationId])).rows;
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  const applicable = entitlements.filter((e) => e.product === "pms" &&
    ["property-management", "pms-core", "account_access"].includes(e.entitlement_key) &&
    (!e.resource_product || (e.resource_product === "pms" && e.resource_type === "pms_property" && e.resource_id === propertyId)) &&
    (!e.starts_at || e.starts_at <= now) && (!e.expires_at || e.expires_at > now));
  return applicable.some((e) => e.status === "active") && !applicable.some((e) => e.status === "suspended");
}
