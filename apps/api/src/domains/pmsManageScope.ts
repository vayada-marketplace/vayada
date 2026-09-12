import { PMS_OPERATING_CALENDAR_AUTHORIZATION } from "@vayada/domain-pms";
import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";

export async function lockPmsManageScope(
  client: DistributionBookingPublicationTransaction,
  command: { organizationId: string; propertyId: string; actorUserId: string },
  at: Date,
): Promise<boolean> {
  const scope = await client.query(
    `SELECT resource.id
     FROM identity.organizations organization
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = $4 AND resource.resource_type = $5
      AND resource.resource_id = $2::uuid::text
      AND resource.relationship = ANY($6::text[]) AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $7
     WHERE organization.id = $1::uuid AND organization.kind = 'hotel_group'
       AND organization.status = 'active'
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [
      command.organizationId,
      command.propertyId,
      command.actorUserId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.allowedRelationships,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.permission,
    ],
  );
  if ((scope.rowCount ?? 0) < 1) return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = $3
       AND entitlement_key = $4
       AND (resource_product IS NULL OR
            (resource_product = $5 AND resource_type = $6
             AND resource_id = $2::uuid::text))
     FOR SHARE`,
    [
      command.organizationId,
      command.propertyId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.key,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
    ],
  );
  const applicable = entitlements.rows.filter(
    ({ startsAt, expiresAt }) =>
      (!startsAt || new Date(startsAt) <= at) && (!expiresAt || new Date(expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}
