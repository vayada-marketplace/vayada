import type { FastifyInstance } from "fastify";

import {
  registerBookingSettingsRoutes,
  type BookingSettingsReadRepository,
} from "./bookingSettings.js";
import { enforceRoutePolicy } from "./policy.js";

type BookingHotelParams = {
  hotelId: string;
};

export type BookingRoutesOptions = {
  settingsRepository?: BookingSettingsReadRepository;
};

export async function registerBookingRoutes(
  app: FastifyInstance,
  options: BookingRoutesOptions = {},
): Promise<void> {
  if (options.settingsRepository) {
    await registerBookingSettingsRoutes(app, options.settingsRepository);
  }

  app.get<{ Params: BookingHotelParams }>("/hotels/:hotelId/policy-check", async (request) => {
    const { hotelId } = request.params;

    const context = enforceRoutePolicy(request, {
      permission: "booking.settings.manage",
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

    return {
      group: "booking",
      authorized: true,
      hotelId,
      userId: context.actor.internalUserId,
    };
  });
}
