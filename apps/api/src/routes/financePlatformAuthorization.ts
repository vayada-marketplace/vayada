import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export function authorizePlatformFinance(
  request: FastifyRequest,
  reply: FastifyReply,
  access: "read" | "manage",
): RequestContext | null {
  try {
    const context = enforceRoutePolicy(request, {
      permission: access === "read" ? "platform.finance.read" : "platform.finance.manage",
      entitlement: {
        product: "platform",
        key: "finance-admin",
        resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
      },
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator", "finance_manager"],
      },
    });
    if (
      context.selectedOrganization.kind !== "platform" ||
      context.selectedOrganization.status !== "active" ||
      !["platform_admin", "finance_manager"].includes(context.membership.roleKey)
    ) {
      throw Object.assign(new Error("Platform Finance organization scope is required."), {
        statusCode: 403,
      });
    }
    return context;
  } catch (error) {
    const statusCode = status(error);
    if (statusCode !== 401 && statusCode !== 403) throw error;
    const code = authorizationCode(request, statusCode, access);
    reply.code(statusCode).send({
      statusCode,
      code,
      category: statusCode === 401 ? "authentication" : "authorization",
      message:
        statusCode === 401
          ? "A valid access token is required."
          : "Platform Finance access is required.",
    });
    return null;
  }
}

function authorizationCode(
  request: FastifyRequest,
  statusCode: 401 | 403,
  access: "read" | "manage",
): string {
  if (statusCode === 401) return "unauthenticated";
  const context = request.authContext;
  if (!context) return "unauthenticated";
  const permission = access === "read" ? "platform.finance.read" : "platform.finance.manage";
  if (!context.membership.permissions.includes(permission)) return "missing_permission";
  const entitlements = context.entitlements.filter(
    (entry) => entry.product === "platform" && entry.key === "finance-admin",
  );
  if (entitlements.some((entry) => entry.status !== "active")) return "inactive_entitlement";
  if (!entitlements.some((entry) => entry.status === "active")) return "missing_entitlement";
  return "missing_resource_access";
}

function status(error: unknown): 401 | 403 | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return value === 401 || value === 403 ? value : null;
}
