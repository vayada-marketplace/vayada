import { requireAuthContext, type PermissionKey } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requirePermission,
  requireResourceAccess,
  type EntitlementRequirement,
  type ResourceRequirement,
} from "@vayada/backend-authorization";
import type { FastifyRequest } from "fastify";

export type RouteAuthorizationPolicy = {
  permission: PermissionKey;
  entitlement?: EntitlementRequirement;
  resource?: ResourceRequirement;
};

export function enforceRoutePolicy(
  request: FastifyRequest,
  policy: RouteAuthorizationPolicy,
): ReturnType<typeof requireAuthContext> {
  const context = requireAuthContext(request);

  requirePermission(context, policy.permission);

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
