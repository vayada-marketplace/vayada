import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AffiliateDraftRepository } from "../domains/marketplaceAffiliateDraftRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Params = { propertyId: string; offerId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorize(request: FastifyRequest) {
  const context = enforceRoutePolicy(request, { permission: "marketplace.profile.manage" });
  if (
    context.selectedOrganization.kind !== "hotel_group" ||
    context.selectedOrganization.status !== "active" ||
    context.actor.status !== "active" ||
    context.membership.status !== "active"
  )
    throw Object.assign(new Error("Hotel access required"), { statusCode: 403 });
  const params = request.params as Params;
  if (!uuid.test(params.propertyId) || !uuid.test(params.offerId))
    throw Object.assign(new Error("Canonical property and offer IDs required"), {
      statusCode: 422,
    });
  params.propertyId = params.propertyId.toLowerCase();
  params.offerId = params.offerId.toLowerCase();
  for (const [resourceType, resourceId] of [
    ["hotel_profile", params.propertyId],
    ["marketplace_offer", params.offerId],
  ] as const)
    enforceRoutePolicy(request, {
      permission: "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType,
        resourceId,
        allowedRelationships: ["owner", "operator"],
      },
    });
  return enforceRoutePolicy(request, {
    permission: "marketplace.profile.manage",
    entitlement: {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: params.propertyId,
      },
    },
  });
}

export async function registerMarketplaceAffiliateDraftRoutes(
  app: FastifyInstance,
  options: { repository: AffiliateDraftRepository },
) {
  const { repository } = options;
  app.addHook("onClose", () => repository.close());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    authorize(request);
  });
  const path = "/properties/:propertyId/offers/:offerId/affiliate-draft";
  app.get<{ Params: Params }>(path, async (request, reply) => {
    const context = authorize(request);
    const result = await repository.read(
      context.selectedOrganization.organizationId,
      request.params.propertyId,
      request.params.offerId,
    );
    return result ?? reply.code(404).send({ code: "scope_unavailable" });
  });
  app.put<{ Params: Params; Body: unknown }>(path, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const key = request.headers["idempotency-key"];
    const headerCount = request.raw.rawHeaders.filter(
      (_, i) => i % 2 === 0 && request.raw.rawHeaders[i]!.toLowerCase() === "idempotency-key",
    ).length;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, "terms") ||
      !Object.hasOwn(body, "expectedRevision") ||
      typeof body.expectedRevision !== "number" ||
      typeof key !== "string" ||
      headerCount !== 1
    )
      return reply.code(422).send({ code: "invalid_request" });
    const result = await repository.save({
      context: authorize(request),
      ...request.params,
      expectedRevision: body.expectedRevision,
      idempotencyKey: key,
      terms: body.terms,
    });
    if (result.ok) return reply.code(result.replayed ? 200 : 201).send(result);
    return reply
      .code(
        result.code === "invalid_request" ? 422 : result.code === "scope_unavailable" ? 404 : 409,
      )
      .send(result);
  });
}
