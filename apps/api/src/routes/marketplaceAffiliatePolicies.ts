import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AffiliatePolicyRepository } from "../domains/financeAffiliatePercentagePolicyRepository.js";
import { enforceRoutePolicy } from "./policy.js";
type Params = { propertyId: string; policyVersionId?: string };
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
    (params.policyVersionId !== undefined && !uuid.test(params.policyVersionId))
  )
    throw Object.assign(new Error("Canonical property and policy IDs required"), {
      statusCode: 422,
    });
  params.propertyId = params.propertyId.toLowerCase();
  if (params.policyVersionId) params.policyVersionId = params.policyVersionId.toLowerCase();
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
function status(result: Awaited<ReturnType<AffiliatePolicyRepository["approve"]>>) {
  if (result.ok) return result.replayed ? 200 : 201;
  return {
    invalid_request: 422,
    scope_unavailable: 404,
    idempotency_conflict: 409,
    already_approved: 409,
  }[result.code];
}
export async function registerMarketplaceAffiliatePolicyRoutes(
  app: FastifyInstance,
  options: { repository: AffiliatePolicyRepository },
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
  const path = "/properties/:propertyId/affiliate-policies";
  app.get<{ Params: Params }>(path, async (request) => {
    const context = authorize(request);
    return repository.list(request.params.propertyId, context.selectedOrganization.organizationId);
  });
  app.get<{ Params: Params }>(`${path}/:policyVersionId`, async (request, reply) => {
    authorize(request);
    const result = await repository.resolve({
      propertyId: request.params.propertyId,
      policyVersionId: request.params.policyVersionId!,
    });
    return reply
      .code(result.status === "available" ? 200 : result.reason === "not_found" ? 404 : 409)
      .send(result);
  });
  app.post<{ Params: Params; Body: unknown }>(path, async (request, reply) => {
    const idempotencyKey = key(request);
    if (!idempotencyKey) return reply.code(422).send({ code: "invalid_request" });
    const result = await repository.save({
      context: authorize(request),
      propertyId: request.params.propertyId,
      idempotencyKey,
      policy: request.body,
    });
    return reply.code(status(result)).send(result);
  });
  app.post<{ Params: Params; Body: unknown }>(
    `${path}/:policyVersionId/approve`,
    async (request, reply) => {
      const idempotencyKey = key(request);
      if (!idempotencyKey || request.body !== undefined)
        return reply.code(422).send({ code: "invalid_request" });
      const result = await repository.approve({
        context: authorize(request),
        propertyId: request.params.propertyId,
        policyVersionId: request.params.policyVersionId!,
        idempotencyKey,
      });
      return reply.code(status(result)).send(result);
    },
  );
}
