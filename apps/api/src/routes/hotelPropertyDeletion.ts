import { UnauthorizedError, requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  HOTEL_PROPERTY_DELETION_CONTRACT_VERSION,
  type HotelPropertyDeletionRequest,
  type HotelPropertyDeletionResult,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  HotelPropertyDeletionError,
  type HotelPropertyDeletionErrorCode,
  type HotelPropertyDeletionRepository,
} from "../domains/hotelPropertyDeletionRepository.js";

/**
 * VAY-2493: PMS › account menu › Manage Properties. Only the account admin (the hotel_owner member) may
 * use these; the repository checks that again inside its transaction.
 *   GET  /api/hotel-setup/properties/:propertyId/deletion-check   what blocks deleting the property
 *   POST /api/hotel-setup/properties/:propertyId/delete           { expectedLifecycleRevision,
 *                                                                   confirmationName } + Idempotency-Key
 */
export type HotelPropertyDeletionRoutesOptions = {
  repository: HotelPropertyDeletionRepository;
};

const ERRORS: Record<HotelPropertyDeletionErrorCode, [number, string]> = {
  account_admin_required: [403, "Only the account admin can delete a property."],
  property_not_found: [404, "This property is not part of the account."],
  property_already_deleted: [409, "This property has already been deleted."],
  lifecycle_revision_conflict: [409, "The property changed meanwhile. Check it again."],
  confirmation_name_mismatch: [422, "Type the property name exactly as shown."],
  deletion_blocked: [409, "Something still blocks deleting this property."],
  property_busy: [503, "The property is busy right now. Try again in a moment."],
  idempotency_key_conflict: [409, "This request was already used for a different delete."],
  command_in_progress: [409, "This delete is still running."],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerHotelPropertyDeletionRoutes(
  app: FastifyInstance,
  options: HotelPropertyDeletionRoutesOptions,
) {
  const { repository } = options;
  app.addHook("onClose", async () => repository.close());

  app.get("/properties/:propertyId/deletion-check", async (request, reply) => {
    const scope = authorize(request, reply);
    if (!scope) return reply;
    reply.header("Cache-Control", "private, no-store");
    try {
      const check = await repository.check(scope);
      if (!check) return sendError(reply, "property_not_found");
      return reply.send(check);
    } catch (error) {
      return handleError(request, reply, error, scope.propertyId, "check");
    }
  });

  app.post("/properties/:propertyId/delete", async (request, reply) => {
    const scope = authorize(request, reply);
    if (!scope) return reply;
    reply.header("Cache-Control", "private, no-store");
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200)
      return reply.status(400).send({
        code: "idempotency_key_required",
        detail: "Idempotency-Key is required and must be at most 200 characters.",
      });
    const body = parseRequest(request.body);
    if (!body)
      return reply.status(400).send({
        code: "invalid_property_deletion",
        detail: "Send the property's revision and its name as typed.",
      });
    try {
      const result = await repository.delete({
        ...scope,
        ...body,
        idempotencyKey,
        audit: {
          requestId: scope.context.audit.requestId,
          correlationId: scope.context.audit.correlationId ?? scope.context.audit.requestId,
          requestedAt: scope.context.audit.receivedAt,
        },
      });
      return reply.send({
        contractVersion: HOTEL_PROPERTY_DELETION_CONTRACT_VERSION,
        propertyId: result.propertyId,
        deleted: true,
      } satisfies HotelPropertyDeletionResult);
    } catch (error) {
      return handleError(request, reply, error, scope.propertyId, "delete");
    }
  });
}

function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
): {
  context: RequestContext;
  organizationId: string;
  actorUserId: string;
  propertyId: string;
} | null {
  let context: RequestContext;
  try {
    context = requireAuthContext(request);
    if (
      context.actor.status !== "active" ||
      context.selectedOrganization.kind !== "hotel_group" ||
      context.selectedOrganization.status !== "active" ||
      context.membership.status !== "active"
    )
      throw new AuthorizationError();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ code: "unauthenticated" });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    throw error;
  }
  if (context.membership.roleKey !== "hotel_owner") {
    sendError(reply, "account_admin_required");
    return null;
  }
  const propertyId = (request.params as { propertyId?: string }).propertyId ?? "";
  if (!UUID.test(propertyId)) {
    reply.status(400).send({ code: "invalid_property_id", detail: "Property ID must be a UUID." });
    return null;
  }
  const linked = context.linkedResources.some(
    (resource) =>
      resource.status === "active" &&
      resource.product === "hotel_catalog" &&
      resource.resourceType === "property" &&
      (resource.relationship === "owner" || resource.relationship === "operator") &&
      resource.resourceId.toLowerCase() === propertyId.toLowerCase(),
  );
  if (!linked) {
    sendError(reply, "property_not_found");
    return null;
  }
  return {
    context,
    organizationId: context.selectedOrganization.organizationId,
    actorUserId: context.actor.internalUserId,
    propertyId: propertyId.toLowerCase(),
  };
}

function parseRequest(body: unknown): HotelPropertyDeletionRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { expectedLifecycleRevision, confirmationName } = body as Record<string, unknown>;
  if (
    typeof expectedLifecycleRevision !== "number" ||
    !Number.isSafeInteger(expectedLifecycleRevision) ||
    expectedLifecycleRevision < 1 ||
    typeof confirmationName !== "string" ||
    !confirmationName.trim() ||
    confirmationName.length > 500
  )
    return null;
  return { expectedLifecycleRevision, confirmationName };
}

function sendError(reply: FastifyReply, code: HotelPropertyDeletionErrorCode, extra = {}) {
  const [status, detail] = ERRORS[code];
  if (code === "property_busy") reply.header("Retry-After", "5");
  return reply.status(status).send({ code, detail, ...extra });
}

function handleError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  propertyId: string,
  action: "check" | "delete",
) {
  if (error instanceof HotelPropertyDeletionError) {
    return sendError(reply, error.code, error.check ? { check: error.check } : {});
  }
  request.log.error({ err: error, propertyId }, `Hotel property deletion ${action} failed`);
  return reply.status(503).send({
    code: "property_deletion_unavailable",
    detail: "Deleting properties is not available right now. Try again later.",
  });
}
