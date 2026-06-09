import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";

import { enforceRoutePolicy } from "./policy.js";

export const BOOKING_ADDON_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/addons",
  permission: "booking.settings.manage",
  entitlement: {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export type BookingAddonSettingsReadModel = {
  showAddonsStep?: boolean | null;
  groupAddonsByCategory?: boolean | null;
};

export type BookingAddonSettingsResponse = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};

export type BookingAddonSettings = BookingAddonSettingsResponse;

export type BookingSettingsReadRepository = {
  findAddonSettingsByHotelId(hotelId: string): Promise<BookingAddonSettingsReadModel | null>;
  close?(): Promise<void>;
};

export type BookingAddonSettingsErrorCategory = "authentication" | "authorization" | "read_model";

export type BookingAddonSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingAddonSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
  message: string;
};

export type BookingAddonSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingAddonSettingsContract = {
  method: typeof BOOKING_ADDON_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_ADDON_SETTINGS_CONTRACT.path;
  request: BookingAddonSettingsRequest;
  response: BookingAddonSettingsResponse;
  error: BookingAddonSettingsError;
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

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/addons",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
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
      } catch (error) {
        const contractError = toBookingAddonSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingAddonSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingAddonSettingsReadModel | null;
      try {
        settings = await repository.findAddonSettingsByHotelId(hotelId);
      } catch {
        return sendBookingAddonSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking add-on settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingAddonSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel addon settings not found.",
        });
      }

      return toAddonSettingsResponse(settings);
    },
  );
}

export function toAddonSettingsResponse(
  settings: BookingAddonSettingsReadModel,
): BookingAddonSettingsResponse {
  return {
    showAddonsStep: settings.showAddonsStep ?? true,
    groupAddonsByCategory: settings.groupAddonsByCategory ?? true,
  };
}

function sendBookingAddonSettingsError(
  reply: FastifyReply,
  error: BookingAddonSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function toBookingAddonSettingsAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingAddonSettingsError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toBookingAddonSettingsAuthorizationErrorCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingAddonSettingsAuthorizationMessage(code),
  };
}

type BookingAddonSettingsAuthorizationErrorCode = Extract<
  BookingAddonSettingsErrorCode,
  "missing_permission" | "missing_entitlement" | "inactive_entitlement" | "missing_resource_access"
>;

function toBookingAddonSettingsAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): BookingAddonSettingsAuthorizationErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingSettingsEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingAddonSettingsAuthorizationMessage(
  code: BookingAddonSettingsAuthorizationErrorCode,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required booking settings permission.";
    case "inactive_entitlement":
      return "Booking engine entitlement is not active.";
    case "missing_entitlement":
      return "Missing active booking engine entitlement.";
    case "missing_resource_access":
      return "Missing booking hotel access.";
  }
}

function hasInactiveBookingSettingsEntitlement(request: FastifyRequest, hotelId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "booking" || entitlement.key !== "booking-engine") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "booking" &&
        entitlement.resource.resourceType === "booking_hotel" &&
        entitlement.resource.resourceId === hotelId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
