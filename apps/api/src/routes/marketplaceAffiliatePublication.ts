import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AffiliatePublicationInput,
  AffiliatePublicationResult,
} from "../domains/marketplaceAffiliatePublication.js";
import { enforceRoutePolicy } from "./policy.js";

type Params = { propertyId: string; offerId: string };
type Publisher = (input: AffiliatePublicationInput) => Promise<AffiliatePublicationResult>;
export type MarketplaceAffiliatePublicationRoutesOptions = {
  publish: Publisher;
  close?: () => Promise<void>;
};
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

function idempotencyKey(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  const count = request.raw.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === "idempotency-key",
  ).length;
  return typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes(",") &&
    count === 1
    ? value
    : null;
}

export async function registerMarketplaceAffiliatePublicationRoutes(
  app: FastifyInstance,
  options: MarketplaceAffiliatePublicationRoutesOptions,
) {
  if (options.close) app.addHook("onClose", options.close);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    authorize(request);
  });
  app.post<{ Params: Params; Body: unknown }>(
    "/properties/:propertyId/offers/:offerId/affiliate-publications",
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | null;
      const key = idempotencyKey(request);
      if (
        !key ||
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        typeof body.draftId !== "string" ||
        typeof body.expectedRevision !== "number"
      )
        return reply.code(422).send({ code: "invalid_request" });
      const result = await options.publish({
        context: authorize(request),
        ...request.params,
        draftId: body.draftId,
        expectedRevision: body.expectedRevision,
        idempotencyKey: key,
      });
      if (result.ok) return reply.code(result.replayed ? 200 : 201).send(result);
      return reply
        .code(
          result.code === "invalid_request" ? 422 : result.code === "scope_unavailable" ? 404 : 409,
        )
        .send(result);
    },
  );
}
