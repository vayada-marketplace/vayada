import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  AffiliateClaimCreatorScope,
  AffiliateDiscrepancyRepository,
} from "../domains/affiliateDiscrepancy.js";
import { enforceRoutePolicy } from "./policy.js";

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
      const result = await options.repository.submit({
        ...parsed.data,
        scope,
        actorUserId: requireAuthContext(request).actor.internalUserId,
        requestId: request.id,
      });
      reply.header("Cache-Control", "private, no-store");
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (caught) {
      if (hasPgCode(caught, "23514") || hasPgCode(caught, "23503"))
        return error(reply, 404, "booking_scope_not_found");
      throw caught;
    }
  });
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
