import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import type {
  BookingPublicationCommandPort,
  BookingPublicationReviewReadPort,
  ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import type { ProductReadinessResult, ReadinessProviderFailure } from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type OperationParams = PropertyParams & { operationId: string };
type PublicationRequestBody = {
  expectedActiveContentRevisionId: string | null;
  expectedSourceManifestHash: string;
  expectedReadinessHash: string;
};
export interface BookingPublicationReadinessProvider {
  getBookingReadiness(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<ProductReadinessResult | ReadinessProviderFailure>;
}

export type BookingPublicationRoutesOptions = {
  propertyAccessRepository: PropertyAccessRepository;
  repository: BookingPublicationCommandPort & Partial<BookingPublicationReviewReadPort>;
  readinessProvider: BookingPublicationReadinessProvider;
};
type AuthorizedPublicationScope = {
  context: Awaited<ReturnType<typeof enforcePropertyRoutePolicy>>;
  propertyId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export async function registerBookingPublicationRoutes(
  app: FastifyInstance,
  { propertyAccessRepository, repository, readinessProvider }: BookingPublicationRoutesOptions,
): Promise<void> {
  const authorizedScopes = new WeakMap<FastifyRequest, AuthorizedPublicationScope>();
  app.addHook("onClose", async () => repository.close?.());

  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const baseContext = enforceRoutePolicy(request, { permission: "booking.settings.manage" });
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      await invalidRequest(reply, "The property ID is invalid.");
      return;
    }
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      throw new AuthorizationError("Booking publication requires a hotel-group organization.");
    }
    const propertyId = rawPropertyId.toLowerCase();
    try {
      await enforcePropertyRoutePolicy(
        request,
        {
          permission: "booking.settings.manage",
          property: {
            propertyId,
            targetResource: { product: "booking", resourceType: "booking_hotel" },
          },
        },
        propertyAccessRepository,
      );
    } catch (error) {
      if (error instanceof AuthorizationError) {
        await forbidden(reply);
        return;
      }
      throw error;
    }
    const resource = {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission: "booking.settings.manage",
      entitlement: { product: "booking", key: "booking-engine", resource },
      resource: { ...resource, allowedRelationships: ["owner", "operator"] },
    });
    authorizedScopes.set(request, { context, propertyId });
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/publications/booking",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = authorizedScopes.get(request);
      if (!scope) return forbidden(reply);
      if (!repository.getPublicationReview)
        return reply.status(503).send({ code: "publication_review_unavailable" });
      const idempotencyKey =
        request.headers["idempotency-key"] === undefined ? undefined : readIdempotencyKey(request);
      if (idempotencyKey === null) return invalidRequest(reply, "The recovery key is invalid.");
      const input = {
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        actorUserId: scope.context.actor.internalUserId,
      };
      const review = await repository.getPublicationReview({
        ...input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if (!review || review.propertyId !== scope.propertyId)
        return reply.status(404).send({ code: "setup_scope_unavailable" });
      // Readiness failures must not hide an accepted operation or previous active revision.
      let readiness;
      try {
        readiness = await readinessProvider.getBookingReadiness(input);
        if (readiness.propertyId !== scope.propertyId || readiness.product !== "booking")
          throw new Error("Readiness scope mismatch");
      } catch {
        readiness = {
          outcome: "provider_failure",
          contractVersion: "onboarding-product-readiness.v1",
          propertyId: scope.propertyId,
          product: "booking",
          status: "error",
          error: {
            kind: "system_error",
            errorSource: "provider",
            code: "readiness_unavailable",
            message: "Booking readiness is temporarily unavailable.",
            retryable: true,
          },
          evaluatedAt: new Date().toISOString(),
        };
      }
      return reply
        .header("Cache-Control", "no-store")
        .send({ contractVersion: "booking-publication-review.v1", ...review, readiness });
    },
  );

  app.post<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/publications/booking",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = authorizedScopes.get(request);
      if (!scope) return forbidden(reply);
      const body = parsePublicationRequest(request.body);
      if (!body) return invalidRequest(reply, "The publication request is invalid.");
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) {
        return invalidRequest(
          reply,
          "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
        );
      }

      const readiness = await readinessProvider.getBookingReadiness({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
      });
      if (
        readiness.outcome !== "evaluated" ||
        readiness.product !== "booking" ||
        readiness.status !== "ready" ||
        readiness.propertyId !== scope.propertyId ||
        readiness.sourceManifestHash !== body.expectedSourceManifestHash ||
        readiness.readinessHash !== body.expectedReadinessHash
      ) {
        return reply.status(409).send({ code: "invalid_readiness_evidence" });
      }

      const result = await repository.requestPublication({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        actorUserId: scope.context.actor.internalUserId,
        idempotencyKey,
        expectedActiveContentRevisionId: body.expectedActiveContentRevisionId,
        readiness: readiness as ReadyBookingPublicationEvidence,
        audit: scope.context.audit,
      });
      if (result.ok) return reply.status(202).send(result.operation);
      return reply
        .status(result.error.code === "setup_scope_unavailable" ? 404 : 409)
        .send(result.error);
    },
  );

  app.get<{ Params: OperationParams }>(
    "/properties/:propertyId/publications/booking/:operationId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = authorizedScopes.get(request);
      if (!scope) return forbidden(reply);
      const operationId = request.params.operationId.toLowerCase();
      if (!UUID_PATTERN.test(operationId)) {
        return invalidRequest(reply, "The operation ID is invalid.");
      }
      const operation = await repository.getPublicationStatus({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        operationId,
        actorUserId: scope.context.actor.internalUserId,
      });
      return operation
        ? reply.send(operation)
        : reply.status(404).send({ code: "publication_operation_not_found" });
    },
  );
}

function parsePublicationRequest(value: unknown): PublicationRequestBody | null {
  if (!isRecord(value)) return null;
  const expectedRevision = value["expectedActiveContentRevisionId"];
  const sourceHash = value["expectedSourceManifestHash"];
  const readinessHash = value["expectedReadinessHash"];
  if (
    !(
      expectedRevision === null ||
      (typeof expectedRevision === "string" && UUID_PATTERN.test(expectedRevision))
    ) ||
    typeof sourceHash !== "string" ||
    !HASH_PATTERN.test(sourceHash) ||
    typeof readinessHash !== "string" ||
    !HASH_PATTERN.test(readinessHash)
  ) {
    return null;
  }
  return {
    expectedActiveContentRevisionId: expectedRevision?.toLowerCase() ?? null,
    expectedSourceManifestHash: sourceHash,
    expectedReadinessHash: readinessHash,
  };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length > 0 && key.length <= 200 ? key : null;
}

function forbidden(reply: FastifyReply): FastifyReply {
  return reply.status(403).send({
    code: "forbidden",
    message: "Booking publication requires an entitled hotel-group property.",
  });
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
