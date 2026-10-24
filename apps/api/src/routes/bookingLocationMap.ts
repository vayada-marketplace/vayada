import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { BookingLocationMapRepository } from "../domains/bookingLocationMap.js";
import { authorizeRequest, exactDataRecord, type AuthorizedScope } from "./bookingGuestPolicy.js";

export type BookingLocationMapRoutesOptions = {
  repository: BookingLocationMapRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

/** Booking Admin → Settings → Location & surroundings: the "Location map on your booking page" switch and what
 * guests would see (VAY-2126). Same access as the hotel's other booking settings. */
export async function registerBookingLocationMapRoutes(
  app: FastifyInstance,
  options: BookingLocationMapRoutesOptions,
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
    if (!scope) throw new Error("Location map authorization missing");
    return scope;
  };

  app.get("/properties/:propertyId/location-map", { onRequest }, async (request, reply) => {
    const { propertyId } = scopeOf(request);
    try {
      const summary = await repository.read(propertyId);
      if (!summary) return reply.status(404).send({ code: "property_not_found" });
      return reply.header("Cache-Control", "private, no-store").send(summary);
    } catch (error) {
      request.log.error({ err: error, propertyId }, "Location map read failed");
      return reply.status(503).send({ code: "location_map_unavailable" });
    }
  });

  // The "Location map on your booking page" switch, and its "Show nearby places" switch (VAY-2326).
  for (const [url, setting] of [
    ["/properties/:propertyId/location-map", "locationMap"],
    ["/properties/:propertyId/location-map/nearby", "nearbyPlaces"],
  ] as const)
    app.put(url, { onRequest }, async (request, reply) => {
      const { propertyId, context } = scopeOf(request);
      if (!exactDataRecord(request.body, ["enabled"]) || typeof request.body.enabled !== "boolean")
        return reply.status(400).send({ code: "invalid_location_map" });
      try {
        const saved = await repository.setEnabled({
          propertyId,
          enabled: request.body.enabled,
          ...(setting === "nearbyPlaces" && { setting }),
          audit: {
            actorUserId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
            requestId: context.audit.requestId,
            correlationId: context.audit.correlationId ?? null,
          },
        });
        if (!saved)
          return reply
            .header("Cache-Control", "no-store")
            .status(409)
            .send({
              code: "booking_settings_missing",
              message:
                setting === "nearbyPlaces"
                  ? "Set up the booking engine before showing nearby places."
                  : "Set up the booking engine before showing the location map.",
            });
        return reply.header("Cache-Control", "no-store").send(saved);
      } catch (error) {
        request.log.error({ err: error, propertyId, setting }, "Location map update failed");
        return reply.status(503).send({ code: "location_map_unavailable" });
      }
    });
}
