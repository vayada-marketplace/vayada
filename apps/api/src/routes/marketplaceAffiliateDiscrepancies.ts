import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  AffiliateClaimCreatorScope,
  AffiliateDiscrepancyRepository,
} from "../domains/affiliateDiscrepancy.js";
import { enforceRoutePolicy } from "./policy.js";
import { authorizePlatformFinance } from "./financePlatformAffiliatePayoutRoutes.js";

const uuidSchema = z.uuid();
const referenceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value));
const referencesSchema = z.array(referenceSchema).min(1).max(20);
const submitSchema = z.object({
  kind: z.enum(["booking_attribution", "earning", "payment"]),
  agreementId: uuidSchema,
  propertyId: uuidSchema,
  bookingId: uuidSchema,
  payoutId: uuidSchema
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  message: z.string().trim().min(1).max(4000),
  evidenceReferences: referencesSchema,
});
const resolutionBase = {
  propertyId: uuidSchema,
  reason: z.string().trim().min(1).max(2000),
  evidenceReferences: referencesSchema,
};
const resolutionSchema = z.discriminatedUnion("decision", [
  z.object({ ...resolutionBase, decision: z.literal("denied") }),
  z.object({
    ...resolutionBase,
    decision: z.literal("confirmed_earning"),
    earningEntryId: uuidSchema,
  }),
  z.object({
    ...resolutionBase,
    decision: z.literal("confirmed_payment"),
    earningEntryId: uuidSchema,
    payoutId: uuidSchema,
  }),
]);
type Body = unknown;

export async function registerMarketplaceAffiliateDiscrepancyRoutes(
  app: FastifyInstance,
  options: { repository?: AffiliateDiscrepancyRepository },
) {
  app.addHook("onClose", () => options.repository?.close());

  app.get("/affiliate-discrepancies", async (request, reply) => {
    const scope = creatorScope(request, reply, "read");
    if (!scope) return reply;
    if (!options.repository) return error(reply, 503, "claim_service_unavailable");
    reply.header("Cache-Control", "private, no-store");
    return { claims: await options.repository.list(scope) };
  });

  app.get<{ Params: { claimId: string } }>(
    "/affiliate-discrepancies/:claimId",
    async (request, reply) => {
      const scope = creatorScope(request, reply, "read");
      if (!scope) return reply;
      if (!uuid(request.params.claimId)) return error(reply, 400, "invalid_claim");
      if (!options.repository) return error(reply, 503, "claim_service_unavailable");
      const claim = await options.repository.get(scope, request.params.claimId);
      if (!claim) return error(reply, 404, "claim_not_found");
      reply.header("Cache-Control", "private, no-store");
      return { claim };
    },
  );

  app.post<{ Body: Body }>("/affiliate-discrepancies", async (request, reply) => {
    const scope = creatorScope(request, reply, "write");
    if (!scope) return reply;
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) return error(reply, 400, "invalid_claim");
    if (!options.repository) return error(reply, 503, "claim_service_unavailable");
    try {
      const context = requireAuthContext(request);
      const result = await options.repository.submit({
        ...parsed.data,
        scope,
        actorUserId: context.actor.internalUserId,
        requestId: context.audit.requestId,
      });
      reply.header("Cache-Control", "private, no-store");
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (caught) {
      if (hasPgCode(caught, "23514") || hasPgCode(caught, "23503"))
        return error(reply, 404, "booking_scope_not_found");
      throw caught;
    }
  });

  app.post<{ Params: { claimId: string }; Body: Body }>(
    "/affiliate-discrepancies/:claimId/resolution",
    async (request, reply) => {
      const baseActor = resolutionBaseActor(request, reply);
      if (!baseActor) return reply;
      if (!uuid(request.params.claimId)) return error(reply, 400, "invalid_resolution");
      const parsed = resolutionSchema.safeParse(request.body);
      const idempotencyKey = singleHeader(request, "idempotency-key");
      if (!parsed.success || !idempotencyKey) return error(reply, 400, "invalid_resolution");
      const actor = resolutionActor(request, reply, baseActor, parsed.data.propertyId);
      if (!actor) return reply;
      if (!options.repository) return error(reply, 503, "claim_service_unavailable");
      const earningEntryId = parsed.data.decision === "denied" ? null : parsed.data.earningEntryId;
      const payoutId = parsed.data.decision === "confirmed_payment" ? parsed.data.payoutId : null;
      try {
        const result = await options.repository.resolve({
          claimId: request.params.claimId,
          propertyId: actor.propertyId,
          resolution: { ...parsed.data, earningEntryId, payoutId },
          idempotencyKey,
          actorUserId: actor.context.actor.internalUserId,
          actorOrganizationId: actor.context.selectedOrganization.organizationId,
          requestId: actor.context.audit.requestId,
        });
        if (!result.ok) {
          return error(
            reply,
            result.code === "not_found" ? 404 : 409,
            result.code === "not_found" ? "claim_not_found" : "resolution_conflict",
          );
        }
        reply.header("Cache-Control", "private, no-store");
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (caught) {
        if (hasPgCode(caught, "23514") || hasPgCode(caught, "23503")) {
          return error(reply, 422, "resolution_evidence_unavailable");
        }
        throw caught;
      }
    },
  );
}

function creatorScope(
  request: FastifyRequest,
  reply: FastifyReply,
  access: "read" | "write",
): AffiliateClaimCreatorScope | null {
  try {
    const context = requireAuthContext(request);
    if (context.selectedOrganization.kind !== "creator_workspace") throw new Error("scope");
    const creator = context.linkedResources.filter(
      (link) =>
        link.product === "marketplace" &&
        link.resourceType === "creator_profile" &&
        link.relationship === "owner" &&
        link.status === "active",
    );
    const affiliate = context.linkedResources.filter(
      (link) =>
        link.product === "affiliate" &&
        link.resourceType === "affiliate" &&
        link.relationship === "owner" &&
        link.status === "active",
    );
    if (creator.length !== 1 || affiliate.length !== 1) throw new Error("scope");
    enforceRoutePolicy(request, {
      permission:
        access === "read" ? "marketplace.collaboration.read" : "marketplace.collaboration.write",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creator[0]!.resourceId,
        allowedRelationships: ["owner"],
      },
    });
    return {
      organizationId: context.selectedOrganization.organizationId,
      creatorProfileId: creator[0]!.resourceId,
      affiliateId: affiliate[0]!.resourceId,
    };
  } catch (caught) {
    const status = hasStatus(caught) && caught.statusCode === 401 ? 401 : 403;
    error(reply, status, status === 401 ? "unauthenticated" : "scope_unavailable");
    return null;
  }
}

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function error(reply: FastifyReply, statusCode: number, code: string) {
  return reply.code(statusCode).send({ code });
}
function hasPgCode(value: unknown, code: string) {
  return value instanceof Error && "code" in value && (value as { code?: unknown }).code === code;
}
function hasStatus(value: unknown): value is Error & { statusCode: number } {
  return (
    value instanceof Error &&
    "statusCode" in value &&
    typeof (value as { statusCode?: unknown }).statusCode === "number"
  );
}

function resolutionBaseActor(request: FastifyRequest, reply: FastifyReply): RequestContext | null {
  try {
    const context = requireAuthContext(request);
    if (context.selectedOrganization.kind === "platform") {
      return authorizePlatformFinance(request, reply, "manage");
    }
    if (context.selectedOrganization.kind !== "hotel_group") throw new Error("scope");
    return enforceRoutePolicy(request, { permission: "marketplace.collaboration.review" });
  } catch (caught) {
    const status = hasStatus(caught) && caught.statusCode === 401 ? 401 : 403;
    error(reply, status, status === 401 ? "unauthenticated" : "resolution_forbidden");
    return null;
  }
}

function resolutionActor(
  request: FastifyRequest,
  reply: FastifyReply,
  context: RequestContext,
  propertyId: string,
) {
  if (context.selectedOrganization.kind === "platform") return { context, propertyId: null };
  try {
    const scoped = enforceRoutePolicy(request, {
      permission: "marketplace.collaboration.review",
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator"],
      },
      entitlement: {
        product: "marketplace",
        key: "marketplace-hotel-profile",
        resource: { product: "marketplace", resourceType: "hotel_profile", resourceId: propertyId },
      },
    });
    return { context: scoped, propertyId };
  } catch (caught) {
    const status = hasStatus(caught) && caught.statusCode === 401 ? 401 : 403;
    error(reply, status, status === 401 ? "unauthenticated" : "resolution_forbidden");
    return null;
  }
}

function singleHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  const count = request.raw.rawHeaders.filter(
    (entry, index) => index % 2 === 0 && entry.toLowerCase() === name,
  ).length;
  return typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 200 &&
    count === 1
    ? value
    : null;
}
