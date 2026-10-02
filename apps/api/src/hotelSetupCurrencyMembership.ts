import type { PermissionKey } from "@vayada/backend-auth";
import {
  hasActiveEntitlement,
  resolveEffectivePropertyAccess,
} from "@vayada/backend-authorization";
import type { UpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import { lockHotelSetupMembership } from "./hotelSetupMembership.js";
import type { beginHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

/** Current membership, actor and base entitlement checks for the native command scope.
 * beginHotelSetupCommandScope already locks the organization and canonical Owner links. */
export async function lockHotelSetupCurrencyMembership(
  client: Parameters<typeof beginHotelSetupCommandScope>[0],
  command: Pick<UpsertPropertyPricingCurrencyCommand, "organizationId" | "propertyId" | "audit">,
  options = { permission: "pms.operations.manage" as PermissionKey, requireBaseAccess: true },
): Promise<boolean> {
  if (command.audit.actor.kind !== "user") return false;
  const membership = await lockHotelSetupMembership(client, {
    organizationId: command.organizationId,
    actorUserId: command.audit.actor.userId,
    propertyId: command.propertyId,
  });
  if (!membership?.scope.productAccess?.pms) return false;
  const { context, scope, permissions } = membership;
  const access = await resolveEffectivePropertyAccess(context, {
    async findMembershipPropertyScope() {
      return scope;
    },
  });
  if (!access?.propertyIds.includes(command.propertyId)) return false;
  if (!permissions.includes(options.permission)) return false;
  if (!options.requireBaseAccess) return true;
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
