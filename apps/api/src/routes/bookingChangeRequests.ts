import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  bookingHotelChangeDecisionFingerprint,
  type BookingHotelChangeDecisionBinding,
  type BookingHotelChangeDecisionContext,
  type BookingHotelChangeRequestRepository,
} from "./bookingWebPublic.js";
import { enforceRoutePolicy } from "./policy.js";

export type { BookingHotelChangeRequestRepository } from "./bookingWebPublic.js";

type BookingChangeRequestParams = {
  hotelId: string;
  bookingId: string;
};

type BookingChangeDecisionParams = BookingChangeRequestParams & {
  changeRequestId: string;
};

type BookingChangeDeclineBody = {
  reason?: string;
};

type BookingExtrasDecisionParams = BookingChangeRequestParams & {
  requestId: string;
};

export async function registerBookingChangeRequestRoutes(
  app: FastifyInstance,
  repository: BookingHotelChangeRequestRepository,
  routeOptions: {
    basePath: string;
    authorize: (
      request: FastifyRequest,
      propertyId: string,
      access: "read" | "write",
    ) =>
      | ReturnType<typeof enforceBookingChangePolicy>
      | Promise<ReturnType<typeof enforceBookingChangePolicy>>;
  } = { basePath: "/hotels/:hotelId/reservations", authorize: enforceBookingChangePolicy },
): Promise<void> {
  app.get<{ Params: BookingChangeRequestParams }>(
    `${routeOptions.basePath}/:bookingId/change-request`,
    async (request) => {
      await routeOptions.authorize(request, request.params.hotelId, "read");
      const result = await repository.findLatestChangeRequest(
        request.params.hotelId,
        request.params.bookingId,
      );
      if (
        result &&
        typeof result === "object" &&
        "providerRequest" in result &&
        result.providerRequest &&
        typeof result.providerRequest === "object"
      ) {
        try {
          await routeOptions.authorize(request, request.params.hotelId, "write");
        } catch {
          return {
            ...result,
            providerRequest: { ...result.providerRequest, allowedActions: [], refreshAction: null },
          };
        }
      }
      return result;
    },
  );

  app.post<{ Params: BookingChangeDecisionParams }>(
    `${routeOptions.basePath}/:bookingId/change-request/:changeRequestId/accept`,
    async (request) => {
      const context = await routeOptions.authorize(request, request.params.hotelId, "write");
      return repository.acceptChangeRequest(
        request.params.hotelId,
        request.params.bookingId,
        request.params.changeRequestId,
        decisionContext(request, context.actor.internalUserId, {
          propertyId: request.params.hotelId,
          bookingId: request.params.bookingId,
          changeRequestId: request.params.changeRequestId,
          decision: "accept",
          note: null,
        }),
      );
    },
  );

  app.post<{ Params: BookingChangeDecisionParams; Body: BookingChangeDeclineBody }>(
    `${routeOptions.basePath}/:bookingId/change-request/:changeRequestId/decline`,
    async (request) => {
      const context = await routeOptions.authorize(request, request.params.hotelId, "write");
      const note = optionalDecisionNote(request.body?.reason);
      return repository.declineChangeRequest(
        request.params.hotelId,
        request.params.bookingId,
        request.params.changeRequestId,
        note,
        decisionContext(request, context.actor.internalUserId, {
          propertyId: request.params.hotelId,
          bookingId: request.params.bookingId,
          changeRequestId: request.params.changeRequestId,
          decision: "decline",
          note,
        }),
      );
    },
  );

  // VAY-2360 part 3: the extras a guest asked for after booking, answered on the PMS booking page.
  app.get<{ Params: BookingChangeRequestParams }>(
    `${routeOptions.basePath}/:bookingId/extras-request`,
    async (request) => {
      await routeOptions.authorize(request, request.params.hotelId, "read");
      if (!repository.findLatestExtrasRequest) throw notFound();
      return (
        (await repository.findLatestExtrasRequest(
          request.params.hotelId,
          request.params.bookingId,
        )) ?? { status: "none" }
      );
    },
  );

  for (const decision of ["accept", "decline"] as const)
    app.post<{ Params: BookingExtrasDecisionParams; Body: BookingChangeDeclineBody }>(
      `${routeOptions.basePath}/:bookingId/extras-request/:requestId/${decision}`,
      async (request) => {
        const context = await routeOptions.authorize(request, request.params.hotelId, "write");
        if (!repository.decideExtrasRequest) throw notFound();
        const note = decision === "decline" ? optionalDecisionNote(request.body?.reason) : null;
        return repository.decideExtrasRequest(
          request.params.hotelId,
          request.params.bookingId,
          request.params.requestId,
          decision,
          note,
          decisionContext(request, context.actor.internalUserId, {
            propertyId: request.params.hotelId,
            bookingId: request.params.bookingId,
            changeRequestId: request.params.requestId,
            decision,
            note,
          }),
        );
      },
    );
}

function notFound() {
  const error = new Error("Extras requests aren't available here.") as Error & {
    statusCode: number;
  };
  error.statusCode = 404;
  return error;
}

function enforceBookingChangePolicy(
  request: FastifyRequest,
  hotelId: string,
  access: "read" | "write",
) {
  const permission = access === "read" ? "booking.reservation.read" : "pms.booking.update";
  return enforceRoutePolicy(request, {
    permission,
    entitlement: {
      product: "booking",
      key: "booking-engine",
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
      },
    },
    resource: {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: hotelId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function decisionContext(
  request: FastifyRequest,
  actorUserId: string,
  decision: BookingHotelChangeDecisionBinding,
): BookingHotelChangeDecisionContext {
  const requestId = String(request.id);
  const idempotencyHeader = request.headers["idempotency-key"];
  const idempotencyKey =
    typeof idempotencyHeader === "string" && idempotencyHeader.trim()
      ? idempotencyHeader.trim()
      : `booking.change.${decision.decision}:${requestId}`;
  return {
    actorUserId,
    requestId,
    correlationId:
      typeof request.headers["x-correlation-id"] === "string"
        ? request.headers["x-correlation-id"]
        : requestId,
    idempotencyKey,
    fingerprint: bookingHotelChangeDecisionFingerprint(decision),
    occurredAt: new Date(),
  };
}

function optionalDecisionNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim();
  if (!note) return null;
  if (note.length > 1000) {
    const error = new Error("Decline reason must be 1000 characters or fewer.") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  }
  return note;
}
