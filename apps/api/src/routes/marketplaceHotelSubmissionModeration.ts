import type { RequestContext } from "@vayada/backend-auth";
import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import {
  MARKETPLACE_HOTEL_SUBMISSION_MODERATION_AUTHORIZATION,
  MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION,
  parseMarketplaceHotelSubmissionDecisionRequest,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createPgMarketplaceHotelSubmissionModerationRepository } from "../domains/marketplaceHotelSubmissionModerationRepository.js";
import { enforceRoutePolicy } from "./policy.js";

export const MARKETPLACE_ADMIN_HOTEL_SUBMISSIONS_CONTRACT = {
  methods: ["GET", "POST"],
  path: "/api/marketplace/admin/hotel-submissions[/:revisionId][/decision]",
  owner: "marketplace",
  ...MARKETPLACE_HOTEL_SUBMISSION_MODERATION_AUTHORIZATION,
  fallback: "none",
  doc: "engineering/marketplace-admin-contract.md",
} as const;

export type MarketplaceHotelSubmissionModerationRoutesOptions = {
  repository: Pick<
    ReturnType<typeof createPgMarketplaceHotelSubmissionModerationRepository>,
    "listPending" | "getReview" | "decide"
  >;
  /** Resolves the public media for the preview; null when media serving isn't configured. */
  mediaResolver(): HotelMediaResolutionPort | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Vayada operators review hotel profiles submitted from setup before they go public. */
export async function registerMarketplaceHotelSubmissionModerationRoutes(
  app: FastifyInstance,
  options: MarketplaceHotelSubmissionModerationRoutesOptions,
) {
  app.get("/admin/hotel-submissions", async (request, reply) => {
    requireAccess(request);
    reply.header("Cache-Control", "no-store");
    return {
      contractVersion: MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION,
      submissions: await options.repository.listPending(),
    };
  });

  app.get<{ Params: { revisionId: string } }>(
    "/admin/hotel-submissions/:revisionId",
    async (request, reply) => {
      requireAccess(request);
      reply.header("Cache-Control", "no-store");
      if (!UUID.test(request.params.revisionId))
        return sendError(reply, 422, "invalid_revision_id");
      const review = await options.repository.getReview(
        request.params.revisionId.toLowerCase(),
        options.mediaResolver(),
      );
      if (!review) return sendError(reply, 404, "submission_not_found");
      return { contractVersion: MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION, review };
    },
  );

  app.post<{ Params: { revisionId: string }; Body: unknown }>(
    "/admin/hotel-submissions/:revisionId/decision",
    async (request, reply) => {
      const context = requireAccess(request);
      reply.header("Cache-Control", "no-store");
      if (!UUID.test(request.params.revisionId))
        return sendError(reply, 422, "invalid_revision_id");
      const idempotencyKey = readSingleIdempotencyKey(request);
      if (!idempotencyKey) return sendError(reply, 422, "idempotency_required");
      const parsed = parseMarketplaceHotelSubmissionDecisionRequest(request.body);
      if (typeof parsed === "string") return sendError(reply, 422, parsed);
      const revisionId = request.params.revisionId.toLowerCase();
      if (parsed.decision === "approve") {
        // Don't publish a page that would answer 404: the public projection needs servable media.
        const review = await options.repository.getReview(revisionId, options.mediaResolver());
        if (!review) return sendError(reply, 404, "submission_not_found");
        if (review.status === "pending" && !review.preview)
          return sendError(reply, 409, "submission_media_unavailable");
      }
      const result = await options.repository.decide({
        revisionId,
        idempotencyKey,
        request: parsed,
        audit: {
          actorUserId: context.actor.internalUserId,
          actorOrganizationId: context.selectedOrganization.organizationId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
          requestedAt: context.audit.receivedAt,
        },
      });
      if (result.ok) return result.response;
      return sendError(
        reply,
        result.error.code === "submission_not_found" ? 404 : 409,
        result.error.code,
      );
    },
  );
}

function requireAccess(request: FastifyRequest): RequestContext {
  const policy = MARKETPLACE_ADMIN_HOTEL_SUBMISSIONS_CONTRACT;
  const resource = {
    product: policy.resource.product,
    resourceType: policy.resource.resourceType,
    resourceId: policy.resource.resourceId,
  } as const;
  return enforceRoutePolicy(request, {
    permission: policy.permission,
    entitlement: { ...policy.entitlement, resource },
    resource: { ...resource, allowedRelationships: [...policy.resource.allowedRelationships] },
  });
}

function readSingleIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function sendError(reply: FastifyReply, statusCode: 404 | 409 | 422, code: string) {
  return reply.status(statusCode).send({
    statusCode,
    code,
    category: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "validation",
    message: code,
  });
}
