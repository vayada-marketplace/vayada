import { requireAuthContext, type PermissionKey } from "@vayada/backend-auth";
import {
  AuthorizationError,
  requireActiveEntitlement,
  requirePropertyAccess,
  requirePermission,
  requireResourceAccess,
  type EntitlementRequirement,
  type PropertyAccessRepository,
  type PropertyAccessRequirement,
  type ResourceRequirement,
} from "@vayada/backend-authorization";
import type { FastifyRequest } from "fastify";

export type RouteAuthorizationPolicy = {
  permission: PermissionKey;
  entitlement?: EntitlementRequirement;
  resource?: ResourceRequirement;
};

function enforceRouteRequirements(
  context: ReturnType<typeof requireAuthContext>,
  policy: RouteAuthorizationPolicy,
): ReturnType<typeof requireAuthContext> {
  if (policy.entitlement) {
    requireActiveEntitlement(context, policy.entitlement);
  }

  if (policy.resource) {
    requireResourceAccess(context, {
      permission: policy.permission,
      resource: policy.resource,
    });
  }

  return context;
}

export function enforceRoutePolicy(
  request: FastifyRequest,
  policy: RouteAuthorizationPolicy,
): ReturnType<typeof requireAuthContext> {
  const context = requireAuthContext(request);
  requirePermission(context, policy.permission);
  return enforceRouteRequirements(context, policy);
}

export async function enforcePropertyRoutePolicy(
  request: FastifyRequest,
  policy: RouteAuthorizationPolicy & { property: PropertyAccessRequirement },
  repository: PropertyAccessRepository,
): Promise<ReturnType<typeof requireAuthContext>> {
  const context = requireAuthContext(request);
  requirePermission(context, policy.permission);
  await requirePropertyAccess(context, repository, policy.property);
  return enforceRouteRequirements(context, policy);
}

/**
 * Whether the caller may use this property in PMS with the permission: for links from Booking
 * Admin into PMS, shown only to people PMS will let in. Never fails the request.
 */
export function canUsePms(
  request: FastifyRequest,
  propertyId: string,
  permission: "pms.operations.read" | "pms.operations.manage" | "pms.reservation.read",
): boolean {
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
  } as const;
  try {
    enforceRoutePolicy(request, {
      permission,
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships: ["owner", "operator", "front_desk"] },
    });
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}
