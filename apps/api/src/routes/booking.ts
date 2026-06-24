import type { FastifyInstance } from "fastify";

import {
  registerBookingAddonItemRoutes,
  type BookingAddonItemsRepository,
} from "./bookingAddonItems.js";
import {
  registerBookingDashboardRoutes,
  type BookingDashboardRoutesOptions,
} from "./bookingDashboard.js";
import {
  registerBookingReservationRoutes,
  type BookingReservationsReadRepository,
} from "./bookingReservations.js";
import {
  registerBookingSettingsRoutes,
  type BookingGuestFormSettingsSync,
  type BookingSettingsReadRepository,
  type BookingSettingsWriteRepository,
} from "./bookingSettings.js";
import { enforceRoutePolicy } from "./policy.js";

type BookingHotelParams = {
  hotelId: string;
};

export type BookingRoutesOptions = {
  addonItemsRepository?: BookingAddonItemsRepository;
  dashboardMetricsReadPort?: BookingDashboardRoutesOptions["metricsReadPort"];
  reservationsRepository?: BookingReservationsReadRepository;
  settingsRepository?: BookingSettingsReadRepository;
  settingsWriteRepository?: BookingSettingsWriteRepository;
  guestFormSettingsSync?: BookingGuestFormSettingsSync;
};

export async function registerBookingRoutes(
  app: FastifyInstance,
  options: BookingRoutesOptions = {},
): Promise<void> {
  if (options.addonItemsRepository) {
    await registerBookingAddonItemRoutes(app, options.addonItemsRepository);
  }

  if (options.settingsRepository) {
    await registerBookingSettingsRoutes(
      app,
      options.settingsRepository,
      options.settingsWriteRepository,
      options.guestFormSettingsSync,
    );
  }

  if (options.reservationsRepository) {
    await registerBookingReservationRoutes(app, options.reservationsRepository);
  }

  if (options.dashboardMetricsReadPort) {
    await registerBookingDashboardRoutes(app, {
      metricsReadPort: options.dashboardMetricsReadPort,
    });
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
