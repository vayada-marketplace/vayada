import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AffiliateCompletionRepository } from "../domains/pmsAffiliateCompletionRepository.js";
import { AuthorizationError } from "@vayada/backend-authorization";
import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";
type Params = { propertyId: string; bookingId: string; stayItemId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function authorize(request: FastifyRequest) {
  const context = enforceRoutePolicy(request, { permission: "marketplace.profile.manage" });
  if (
    context.actor.status !== "active" ||
    context.membership.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active"
  )
    throw Object.assign(new Error("Hotel access required"), { statusCode: 403 });
  const params = request.params as Params;
  if (
    !uuid.test(params.propertyId) ||
    !uuid.test(params.bookingId) ||
    !uuid.test(params.stayItemId)
  )
    throw Object.assign(new Error("Canonical property, booking and stay-item IDs required"), {
      statusCode: 422,
    });
  params.propertyId = params.propertyId.toLowerCase();
  params.bookingId = params.bookingId.toLowerCase();
  params.stayItemId = params.stayItemId.toLowerCase();
  const resource = {
    product: "marketplace" as const,
    resourceType: "hotel_profile" as const,
    resourceId: params.propertyId,
  };
  enforceRoutePolicy(request, {
    permission: "marketplace.profile.manage",
    entitlement: { product: "marketplace", key: "marketplace-hotel-profile", resource },
  });
  try {
    return await enforcePropertyRoutePolicy(
      request,
      {
        permission: "marketplace.profile.manage",
        property: {
          propertyId: params.propertyId,
          targetResource: { product: "marketplace", resourceType: "hotel_profile" },
          allowedRelationships: ["owner", "operator"],
        },
      },
      { findMembershipPropertyScope: async () => null },
    );
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw Object.assign(new Error("Property scope unavailable"), { statusCode: 404 });
    throw error;
  }
}

export async function registerMarketplaceAffiliateCompletionRoutes(
  app: FastifyInstance,
  options: { repository: AffiliateCompletionRepository },
) {
  const { repository } = options;
  app.addHook("onClose", () => repository.close());
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    await authorize(request);
  });
  app.get<{ Params: Params }>(
    "/properties/:propertyId/bookings/:bookingId/stay-items/:stayItemId/affiliate-completion",
    async (request, reply) => {
      const result = await repository.read({
        ...request.params,
        context: await authorize(request),
      });
      if (result.status === "pending" && result.reason === "scope_unavailable")
        return reply.code(404).send({ code: "scope_unavailable" });
      return result;
    },
  );
}
