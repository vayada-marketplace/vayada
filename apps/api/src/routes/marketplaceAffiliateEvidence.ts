import type { FastifyInstance } from "fastify";
import type { AffiliateEvidenceReviewRepository } from "../domains/affiliateEvidenceReview.js";
import { enforceRoutePolicy } from "./policy.js";

/** Hotel-only evidence review; no ingestion, verification or earning command. */
export async function registerMarketplaceAffiliateEvidenceRoutes(
  app: FastifyInstance,
  options: { repository: AffiliateEvidenceReviewRepository },
) {
  app.addHook("onClose", () => options.repository.close());
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.get<{
    Params: { propertyId: string; observationId: string };
    Querystring: { after?: string };
  }>("/properties/:propertyId/affiliate-evidence/:observationId", async (request, reply) => {
    const context = enforceRoutePolicy(request, { permission: "marketplace.profile.manage" });
    if (
      context.actor.status !== "active" ||
      context.membership.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group" ||
      context.selectedOrganization.status !== "active"
    )
      return reply.code(403).send({ code: "hotel_access_required" });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const { propertyId, observationId } = request.params;
    const after = request.query.after;
    if (
      ![propertyId, observationId, ...(after === undefined ? [] : [after])].every(
        (value) => typeof value === "string" && uuid.test(value),
      )
    )
      return reply.code(422).send({ code: "invalid_request" });
    const resource = {
      product: "marketplace" as const,
      resourceType: "hotel_profile" as const,
      resourceId: propertyId.toLowerCase(),
    };
    enforceRoutePolicy(request, {
      permission: "marketplace.profile.manage",
      resource: { ...resource, allowedRelationships: ["owner", "operator"] },
      entitlement: { product: "marketplace", key: "marketplace-hotel-profile", resource },
    });
    const result = await options.repository.read(
      resource.resourceId,
      context.selectedOrganization.organizationId,
      observationId.toLowerCase(),
      after?.toLowerCase() ?? null,
    );
    return result ?? reply.code(404).send({ code: "not_found" });
  });
}
