import type { FastifyInstance } from "fastify";
import pg from "pg";

import { enforceRoutePolicy } from "./policy.js";

export type BookingAddonSettingsReadModel = {
  showAddonsStep?: boolean | null;
  groupAddonsByCategory?: boolean | null;
};

export type BookingAddonSettingsResponse = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};

export type BookingSettingsReadRepository = {
  findAddonSettingsByHotelId(hotelId: string): Promise<BookingAddonSettingsReadModel | null>;
  close?(): Promise<void>;
};

type BookingHotelParams = {
  hotelId: string;
};

type BookingAddonSettingsRow = {
  show_addons_step: boolean | null;
  group_addons_by_category: boolean | null;
};

export function createPgBookingSettingsReadRepository(config: {
  connectionString: string;
  max?: number;
}): BookingSettingsReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking settings repository connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findAddonSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingAddonSettingsRow>(
        `SELECT show_addons_step, group_addons_by_category
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        showAddonsStep: row.show_addons_step,
        groupAddonsByCategory: row.group_addons_by_category,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerBookingSettingsRoutes(
  app: FastifyInstance,
  repository: BookingSettingsReadRepository,
): Promise<void> {
  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: BookingHotelParams }>("/hotels/:hotelId/settings/addons", async (request) => {
    const { hotelId } = request.params;

    enforceRoutePolicy(request, {
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

    const settings = await repository.findAddonSettingsByHotelId(hotelId);
    if (!settings) {
      throw createHttpError(404, "Booking hotel addon settings not found.");
    }

    return toAddonSettingsResponse(settings);
  });
}

export function toAddonSettingsResponse(
  settings: BookingAddonSettingsReadModel,
): BookingAddonSettingsResponse {
  return {
    showAddonsStep: settings.showAddonsStep ?? true,
    groupAddonsByCategory: settings.groupAddonsByCategory ?? true,
  };
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
