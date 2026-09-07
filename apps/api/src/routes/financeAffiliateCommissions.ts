import type { MarketplaceAffiliateAdminRepository } from "@vayada/domain-marketplace";
import type { FinanceAffiliateCommissionRepository } from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };

export type FinanceAffiliateCommissionRoutesOptions = {
  repository: FinanceAffiliateCommissionRepository;
  affiliateScope: Pick<MarketplaceAffiliateAdminRepository, "getAffiliate">;
  now?: () => Date;
};

export async function registerFinanceAffiliateCommissionRoutes(
  app: FastifyInstance,
  options: FinanceAffiliateCommissionRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => options.repository.close?.());

  for (const url of [
    "/properties/:propertyId/affiliate-commission",
    "/properties/:propertyId/affiliates/:affiliateId/commission",
  ]) {
    app.route<{ Params: PropertyParams }>({
      method: ["GET", "PATCH"],
      url,
      async handler(request, reply) {
        if (!(await authorize(options, request, reply, request.params.propertyId))) return reply;
        return reply.header("Cache-Control", "no-store").code(410).send({
          code: "affiliate_commission_configuration_retired",
        });
      },
    });
  }
}

async function authorize(
  options: FinanceAffiliateCommissionRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
) {
  let context: ReturnType<typeof enforceRoutePolicy>;
  try {
    context = enforceRoutePolicy(request, { permission: "pms.finance.manage" });
  } catch (error) {
    if (!isStatusError(error) || error.statusCode !== 401) {
      return sendDenied(reply, error, "missing_permission");
    }
    sendError(reply, 401, "unauthenticated");
    return null;
  }
  try {
    enforceRoutePolicy(request, {
      permission: "pms.finance.manage",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    });
  } catch (error) {
    return sendDenied(reply, error, "missing_resource_access");
  }

  const pmsEntitlements = context.entitlements.filter(
    (entitlement) =>
      entitlement.product === "pms" &&
      entitlement.key === "property-management" &&
      (entitlement.resource === undefined || entitlement.resource.resourceId === propertyId),
  );
  if (pmsEntitlements.some((entitlement) => entitlement.status === "active")) return context;

  const financeAccess = await options.repository.getBookingFinanceAccess(
    propertyId,
    context.selectedOrganization.organizationId,
  );
  if (financeAccess !== "active") {
    sendError(
      reply,
      403,
      pmsEntitlements.length || financeAccess === "inactive"
        ? "inactive_entitlement"
        : "missing_entitlement",
    );
    return null;
  }
  return context;
}

function sendDenied(reply: FastifyReply, error: unknown, code: string): null {
  if (!isStatusError(error) || error.statusCode !== 403) throw error;
  sendError(reply, 403, code);
  return null;
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ code });
}
