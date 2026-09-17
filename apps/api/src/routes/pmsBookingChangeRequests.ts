import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyInstance } from "fastify";
import {
  registerBookingChangeRequestRoutes,
  type BookingHotelChangeRequestRepository,
} from "./bookingChangeRequests.js";
import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";
import { writePmsOperationsCorsHeaders } from "./pmsOperations.js";

export async function registerPmsBookingChangeRequestRoutes(
  app: FastifyInstance,
  options: {
    repository: BookingHotelChangeRequestRepository;
    propertyAccessRepository: PropertyAccessRepository;
    allowedOrigins: string[];
  },
) {
  app.addHook("onRequest", async (request, reply) => {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins)) {
      return reply
        .code(403)
        .send({ code: "missing_permission", message: "PMS operations origin is not allowed." });
    }
  });
  await registerBookingChangeRequestRoutes(app, options.repository, {
    basePath: "/properties/:hotelId/reservations",
    authorize: (request, propertyId, access) =>
      enforcePmsPropertyRoutePolicy(
        request,
        {
          propertyId,
          permission: access === "read" ? "pms.reservation.read" : "pms.reservation.update",
          allowedRelationships: ["owner", "operator", "front_desk"],
        },
        options.propertyAccessRepository,
      ),
  });
}
