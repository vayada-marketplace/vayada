import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import {
  parseRoomSorting,
  type BookingRoomSortingRepository,
} from "../domains/bookingRoomSorting.js";
import { authorizeRequest, type AuthorizedScope } from "./bookingGuestPolicy.js";

export type BookingRoomSortingRoutesOptions = {
  repository: BookingRoomSortingRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

/** Booking Admin → Settings → Room Sorting (VAY-2449): the guest sort menu's switch, one-room auto-hide,
 * options in order and default. Same access as the hotel's other booking settings. */
export async function registerBookingRoomSortingRoutes(
  app: FastifyInstance,
  options: BookingRoomSortingRoutesOptions,
) {
  const { repository, propertyAccessRepository } = options;
  app.addHook("onClose", async () => repository.close?.());
  const scopes = new WeakMap<FastifyRequest, AuthorizedScope>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const authorized = await authorizeRequest(request, reply, propertyAccessRepository);
    if (authorized) scopes.set(request, authorized);
  };
  const scopeOf = (request: FastifyRequest) => {
    const scope = scopes.get(request);
    if (!scope) throw new Error("Room sorting authorization missing");
    return scope;
  };
  const url = "/properties/:propertyId/room-sorting";

  app.get(url, { onRequest }, async (request, reply) => {
    const { propertyId } = scopeOf(request);
    try {
      const summary = await repository.read(propertyId);
      if (!summary) return reply.status(404).send({ code: "property_not_found" });
      return reply.header("Cache-Control", "private, no-store").send(summary);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "Room sorting read failed");
      return reply.status(503).send({ code: "room_sorting_unavailable" });
    }
  });

  app.put(url, { onRequest }, async (request, reply) => {
    const { propertyId, context } = scopeOf(request);
    const sorting = parseRoomSorting(request.body);
    if (!sorting)
      return reply.status(400).send({
        code: "invalid_room_sorting",
        message:
          "List every sort option once, show at least one, and pick one of those shown as the default.",
      });
    try {
      const saved = await repository.save({
        propertyId,
        sorting,
        audit: {
          actorUserId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
        },
      });
      if (!saved)
        return reply.header("Cache-Control", "no-store").status(409).send({
          code: "booking_settings_missing",
          message: "Set up the booking engine before choosing how guests sort rooms.",
        });
      return reply.header("Cache-Control", "no-store").send({ sorting: saved });
    } catch (error) {
      request.log.error({ err: error, propertyId }, "Room sorting update failed");
      return reply.status(503).send({ code: "room_sorting_unavailable" });
    }
  });
}
