import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AffiliateDestinationRepository } from "../domains/bookingAffiliateDestinationRepository.js";
import { enforceRoutePolicy } from "./policy.js";
type Params = { propertyId: string; destinationVersionId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorize(request: FastifyRequest) {
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
    (params.destinationVersionId !== undefined && !uuid.test(params.destinationVersionId))
  )
    throw Object.assign(new Error("Canonical property and destination IDs required"), {
      statusCode: 422,
    });
  params.propertyId = params.propertyId.toLowerCase();
  if (params.destinationVersionId)
    params.destinationVersionId = params.destinationVersionId.toLowerCase();
  const resource = {
    product: "marketplace" as const,
    resourceType: "hotel_profile" as const,
    resourceId: params.propertyId,
  };
  return enforceRoutePolicy(request, {
    permission: "marketplace.profile.manage",
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
    entitlement: { product: "marketplace", key: "marketplace-hotel-profile", resource },
  });
}
function key(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  const count = request.raw.rawHeaders.filter(
    (v, i) => i % 2 === 0 && v.toLowerCase() === "idempotency-key",
  ).length;
  return typeof value === "string" &&
    value.trim() &&
    value.length <= 200 &&
    !value.includes(",") &&
    count === 1
    ? value
    : null;
}
function status(result: Awaited<ReturnType<AffiliateDestinationRepository["save"]>>) {
  if (result.ok) return result.replayed ? 200 : 201;
  return {
    invalid_request: 422,
    scope_unavailable: 404,
    idempotency_conflict: 409,
  }[result.code];
}
export async function registerMarketplaceAffiliateDestinationRoutes(
  app: FastifyInstance,
  options: { repository: AffiliateDestinationRepository },
) {
  const { repository } = options;
  app.addHook("onClose", () => repository.close());
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    authorize(request);
  });
  const path = "/properties/:propertyId/affiliate-destinations";
  app.get<{ Params: Params }>(path, async (request) => {
    const context = authorize(request);
    return repository.list(request.params.propertyId, context.selectedOrganization.organizationId);
  });
  app.get<{ Params: Params }>(`${path}/:destinationVersionId`, async (request, reply) => {
    const context = authorize(request);
    const result = await repository.get(
      request.params.propertyId,
      context.selectedOrganization.organizationId,
      request.params.destinationVersionId!,
    );
    return result ?? reply.code(404).send({ code: "not_found" });
  });
  app.post<{ Params: Params; Body: unknown }>(path, async (request, reply) => {
    const idempotencyKey = key(request);
    if (!idempotencyKey) return reply.code(422).send({ code: "invalid_request" });
    const result = await repository.save({
      context: authorize(request),
      propertyId: request.params.propertyId,
      idempotencyKey,
      configuration: request.body,
    });
    return reply.code(status(result)).send(result);
  });
}
