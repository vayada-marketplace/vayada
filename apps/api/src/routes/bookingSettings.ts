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

export const BOOKING_GUEST_FORM_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/guest-form",
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

export const BOOKING_BENEFITS_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/benefits",
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

export const BOOKING_LOCALIZATION_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/localization",
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

export const BOOKING_ROOM_FILTER_SETTINGS_CONTRACT = {
  method: "GET",
  path: "/api/booking/hotels/:hotelId/settings/room-filters",
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

export const BOOKING_ADDON_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_ADDON_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_GUEST_FORM_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_BENEFITS_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_LOCALIZATION_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export const BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT = {
  ...BOOKING_ROOM_FILTER_SETTINGS_CONTRACT,
  method: "PUT",
} as const;

export type BookingAddonSettingsReadModel = {
  showAddonsStep?: boolean | null;
  groupAddonsByCategory?: boolean | null;
};

export type BookingGuestFormSettingsReadModel = {
  specialRequestsEnabled?: boolean | null;
  arrivalTimeEnabled?: boolean | null;
  guestCountEnabled?: boolean | null;
};

export type BookingBenefitsSettingsReadModel = {
  benefits?: unknown;
};

export type BookingLocalizationSettingsReadModel = {
  defaultCurrency?: string | null;
  defaultLanguage?: string | null;
  supportedCurrencies?: unknown;
  supportedLanguages?: unknown;
};

export type BookingRoomFilterSettingsReadModel = {
  bookingFilters?: unknown;
  customFilters?: unknown;
  filterRooms?: unknown;
};

export type BookingAddonSettingsResponse = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};

export type BookingGuestFormSettingsResponse = {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
};

export type BookingBenefitsSettingsResponse = {
  benefits: string[];
};

export type BookingLocalizationSettingsResponse = {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
};

export type BookingRoomFilterSettingsResponse = {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
};

export type BookingAddonSettings = BookingAddonSettingsResponse;
export type BookingGuestFormSettings = BookingGuestFormSettingsResponse;
export type BookingBenefitsSettings = BookingBenefitsSettingsResponse;
export type BookingLocalizationSettings = BookingLocalizationSettingsResponse;
export type BookingRoomFilterSettings = BookingRoomFilterSettingsResponse;

export type BookingSettingsReadRepository = {
  findAddonSettingsByHotelId(hotelId: string): Promise<BookingAddonSettingsReadModel | null>;
  findGuestFormSettingsByHotelId(
    hotelId: string,
  ): Promise<BookingGuestFormSettingsReadModel | null>;
  findBenefitsSettingsByHotelId(hotelId: string): Promise<BookingBenefitsSettingsReadModel | null>;
  findLocalizationSettingsByHotelId(
    hotelId: string,
  ): Promise<BookingLocalizationSettingsReadModel | null>;
  findRoomFilterSettingsByHotelId?(
    hotelId: string,
  ): Promise<BookingRoomFilterSettingsReadModel | null>;
  close?(): Promise<void>;
};

export type UpdateBookingAddonSettingsBody = BookingAddonSettingsResponse;
export type UpdateBookingGuestFormSettingsBody = BookingGuestFormSettingsResponse;
export type UpdateBookingBenefitsSettingsBody = BookingBenefitsSettingsResponse;
export type UpdateBookingLocalizationSettingsBody = BookingLocalizationSettingsResponse;
export type UpdateBookingRoomFilterSettingsBody = BookingRoomFilterSettingsResponse;

export type BookingSettingsWriteRepository = {
  updateAddonSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingAddonSettingsBody,
  ): Promise<BookingAddonSettingsReadModel | null>;
  updateGuestFormSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingGuestFormSettingsBody,
  ): Promise<BookingGuestFormSettingsReadModel | null>;
  updateBenefitsSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingBenefitsSettingsBody,
  ): Promise<BookingBenefitsSettingsReadModel | null>;
  updateLocalizationSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingLocalizationSettingsBody,
  ): Promise<BookingLocalizationSettingsReadModel | null>;
  updateRoomFilterSettingsByHotelId(
    hotelId: string,
    settings: UpdateBookingRoomFilterSettingsBody,
  ): Promise<BookingRoomFilterSettingsReadModel | null>;
  close?(): Promise<void>;
};

export type BookingGuestFormSettingsSync = {
  syncGuestFormSettingsByHotelId(
    hotelId: string,
    settings: BookingGuestFormSettingsResponse,
    authHeader?: string,
  ): Promise<void>;
  close?(): Promise<void>;
};

export type BookingSettingsRepository = BookingSettingsReadRepository &
  BookingSettingsWriteRepository;

export type BookingSettingsWriteErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "write_model";

export type BookingSettingsWriteErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "not_found"
  | "write_model_unavailable";

export type BookingSettingsWriteError = {
  statusCode: 401 | 403 | 404 | 422 | 500;
  code: BookingSettingsWriteErrorCode;
  category: BookingSettingsWriteErrorCategory;
  message: string;
  details?: unknown;
};

export type BookingAddonSettingsErrorCategory = "authentication" | "authorization" | "read_model";
export type BookingGuestFormSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingAddonSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingGuestFormSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingBenefitsSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingLocalizationSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingRoomFilterSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingBenefitsSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

export type BookingLocalizationSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export type BookingRoomFilterSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

export type BookingAddonSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
  message: string;
};

export type BookingGuestFormSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingGuestFormSettingsErrorCode;
  category: BookingGuestFormSettingsErrorCategory;
  message: string;
};

export type BookingBenefitsSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingBenefitsSettingsErrorCode;
  category: BookingBenefitsSettingsErrorCategory;
  message: string;
};

export type BookingLocalizationSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLocalizationSettingsErrorCode;
  category: BookingLocalizationSettingsErrorCategory;
  message: string;
};

export type BookingRoomFilterSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingRoomFilterSettingsErrorCode;
  category: BookingRoomFilterSettingsErrorCategory;
  message: string;
};

export type BookingAddonSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingGuestFormSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingBenefitsSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingLocalizationSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type BookingRoomFilterSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};

export type UpdateBookingAddonSettingsRequest = BookingAddonSettingsRequest & {
  body: UpdateBookingAddonSettingsBody;
};

export type UpdateBookingGuestFormSettingsRequest = BookingGuestFormSettingsRequest & {
  body: UpdateBookingGuestFormSettingsBody;
};

export type UpdateBookingBenefitsSettingsRequest = BookingBenefitsSettingsRequest & {
  body: UpdateBookingBenefitsSettingsBody;
};

export type UpdateBookingLocalizationSettingsRequest = BookingLocalizationSettingsRequest & {
  body: UpdateBookingLocalizationSettingsBody;
};

export type UpdateBookingRoomFilterSettingsRequest = BookingRoomFilterSettingsRequest & {
  body: UpdateBookingRoomFilterSettingsBody;
};

export type BookingAddonSettingsContract = {
  method: typeof BOOKING_ADDON_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_ADDON_SETTINGS_CONTRACT.path;
  request: BookingAddonSettingsRequest;
  response: BookingAddonSettingsResponse;
  error: BookingAddonSettingsError;
};

export type BookingGuestFormSettingsContract = {
  method: typeof BOOKING_GUEST_FORM_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_GUEST_FORM_SETTINGS_CONTRACT.path;
  request: BookingGuestFormSettingsRequest;
  response: BookingGuestFormSettingsResponse;
  error: BookingGuestFormSettingsError;
};

export type BookingBenefitsSettingsContract = {
  method: typeof BOOKING_BENEFITS_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_BENEFITS_SETTINGS_CONTRACT.path;
  request: BookingBenefitsSettingsRequest;
  response: BookingBenefitsSettingsResponse;
  error: BookingBenefitsSettingsError;
};

export type BookingLocalizationSettingsContract = {
  method: typeof BOOKING_LOCALIZATION_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_LOCALIZATION_SETTINGS_CONTRACT.path;
  request: BookingLocalizationSettingsRequest;
  response: BookingLocalizationSettingsResponse;
  error: BookingLocalizationSettingsError;
};

export type BookingRoomFilterSettingsContract = {
  method: typeof BOOKING_ROOM_FILTER_SETTINGS_CONTRACT.method;
  path: typeof BOOKING_ROOM_FILTER_SETTINGS_CONTRACT.path;
  request: BookingRoomFilterSettingsRequest;
  response: BookingRoomFilterSettingsResponse;
  error: BookingRoomFilterSettingsError;
};

export type UpdateBookingAddonSettingsContract = {
  method: typeof BOOKING_ADDON_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_ADDON_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingAddonSettingsRequest;
  response: BookingAddonSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingGuestFormSettingsContract = {
  method: typeof BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_GUEST_FORM_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingGuestFormSettingsRequest;
  response: BookingGuestFormSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingBenefitsSettingsContract = {
  method: typeof BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_BENEFITS_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingBenefitsSettingsRequest;
  response: BookingBenefitsSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingLocalizationSettingsContract = {
  method: typeof BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_LOCALIZATION_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingLocalizationSettingsRequest;
  response: BookingLocalizationSettingsResponse;
  error: BookingSettingsWriteError;
};

export type UpdateBookingRoomFilterSettingsContract = {
  method: typeof BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT.method;
  path: typeof BOOKING_ROOM_FILTER_SETTINGS_WRITE_CONTRACT.path;
  request: UpdateBookingRoomFilterSettingsRequest;
  response: BookingRoomFilterSettingsResponse;
  error: BookingSettingsWriteError;
};

type BookingHotelParams = {
  hotelId: string;
};

type BookingAddonSettingsRow = {
  show_addons_step: boolean | null;
  group_addons_by_category: boolean | null;
};

type BookingGuestFormSettingsRow = {
  special_requests_enabled: boolean | null;
  arrival_time_enabled: boolean | null;
  guest_count_enabled: boolean | null;
};

type BookingBenefitsSettingsRow = {
  benefits: unknown;
};

type BookingLocalizationSettingsRow = {
  currency: string | null;
  default_language: string | null;
  supported_currencies: unknown;
  supported_languages: unknown;
};

type BookingRoomFilterSettingsRow = {
  booking_filters: unknown;
  custom_filters: unknown;
  filter_rooms: unknown;
};

export function createPgBookingSettingsReadRepository(config: {
  connectionString: string;
  max?: number;
}): BookingSettingsRepository {
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
    async findGuestFormSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingGuestFormSettingsRow>(
        `SELECT special_requests_enabled, arrival_time_enabled, guest_count_enabled
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        specialRequestsEnabled: row.special_requests_enabled,
        arrivalTimeEnabled: row.arrival_time_enabled,
        guestCountEnabled: row.guest_count_enabled,
      };
    },
    async findBenefitsSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingBenefitsSettingsRow>(
        `SELECT benefits
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        benefits: row.benefits,
      };
    },
    async findLocalizationSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingLocalizationSettingsRow>(
        `SELECT currency, default_language, supported_currencies, supported_languages
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        defaultCurrency: row.currency,
        defaultLanguage: row.default_language,
        supportedCurrencies: row.supported_currencies,
        supportedLanguages: row.supported_languages,
      };
    },
    async findRoomFilterSettingsByHotelId(hotelId) {
      const result = await pool.query<BookingRoomFilterSettingsRow>(
        `SELECT booking_filters, custom_filters, filter_rooms
         FROM booking_hotels
         WHERE id = $1`,
        [hotelId],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        bookingFilters: row.booking_filters,
        customFilters: row.custom_filters,
        filterRooms: row.filter_rooms,
      };
    },
    async updateAddonSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingAddonSettingsRow>(
        `UPDATE booking_hotels
         SET show_addons_step = $2,
             group_addons_by_category = $3
         WHERE id = $1
         RETURNING show_addons_step, group_addons_by_category`,
        [hotelId, settings.showAddonsStep, settings.groupAddonsByCategory],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        showAddonsStep: row.show_addons_step,
        groupAddonsByCategory: row.group_addons_by_category,
      };
    },
    async updateGuestFormSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingGuestFormSettingsRow>(
        `UPDATE booking_hotels
         SET special_requests_enabled = $2,
             arrival_time_enabled = $3,
             guest_count_enabled = $4
         WHERE id = $1
         RETURNING special_requests_enabled, arrival_time_enabled, guest_count_enabled`,
        [
          hotelId,
          settings.specialRequestsEnabled,
          settings.arrivalTimeEnabled,
          settings.guestCountEnabled,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        specialRequestsEnabled: row.special_requests_enabled,
        arrivalTimeEnabled: row.arrival_time_enabled,
        guestCountEnabled: row.guest_count_enabled,
      };
    },
    async updateBenefitsSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingBenefitsSettingsRow>(
        `UPDATE booking_hotels
         SET benefits = $2::jsonb
         WHERE id = $1
         RETURNING benefits`,
        [hotelId, JSON.stringify(settings.benefits)],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        benefits: row.benefits,
      };
    },
    async updateLocalizationSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingLocalizationSettingsRow>(
        `UPDATE booking_hotels
         SET currency = $2,
             default_language = $3,
             supported_currencies = $4::jsonb,
             supported_languages = $5::jsonb
         WHERE id = $1
         RETURNING currency, default_language, supported_currencies, supported_languages`,
        [
          hotelId,
          settings.defaultCurrency,
          settings.defaultLanguage,
          JSON.stringify(settings.supportedCurrencies),
          JSON.stringify(settings.supportedLanguages),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        defaultCurrency: row.currency,
        defaultLanguage: row.default_language,
        supportedCurrencies: row.supported_currencies,
        supportedLanguages: row.supported_languages,
      };
    },
    async updateRoomFilterSettingsByHotelId(hotelId, settings) {
      const result = await pool.query<BookingRoomFilterSettingsRow>(
        `UPDATE booking_hotels
         SET booking_filters = $2::jsonb,
             custom_filters = $3::jsonb,
             filter_rooms = $4::jsonb
         WHERE id = $1
         RETURNING booking_filters, custom_filters, filter_rooms`,
        [
          hotelId,
          JSON.stringify(settings.bookingFilters),
          JSON.stringify(settings.customFilters),
          JSON.stringify(settings.filterRooms),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;

      return {
        bookingFilters: row.booking_filters,
        customFilters: row.custom_filters,
        filterRooms: row.filter_rooms,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

export function createHttpPmsGuestFormSettingsSync(config: {
  pmsApiUrl: string;
  fetch?: typeof fetch;
}): BookingGuestFormSettingsSync {
  const baseUrl = config.pmsApiUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("PMS guest-form settings sync pmsApiUrl must not be empty");
  }

  const endpoint = `${baseUrl}/admin/guest-form-settings`;
  new URL(endpoint);

  const fetchImpl = config.fetch ?? fetch;
  return {
    async syncGuestFormSettingsByHotelId(hotelId, settings, authHeader) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-hotel-id": hotelId,
      };
      if (authHeader?.trim()) {
        headers.authorization = authHeader;
      }

      const response = await fetchImpl(endpoint, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          special_requests_enabled: settings.specialRequestsEnabled,
          arrival_time_enabled: settings.arrivalTimeEnabled,
          guest_count_enabled: settings.guestCountEnabled,
        }),
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`PMS guest-form settings sync failed with ${response.status}: ${details}`);
      }
    },
  };
}

export async function registerBookingSettingsRoutes(
  app: FastifyInstance,
  repository: BookingSettingsReadRepository,
  writeRepository?: BookingSettingsWriteRepository,
  guestFormSettingsSync?: BookingGuestFormSettingsSync,
): Promise<void> {
  const closeables = new Set([repository, writeRepository, guestFormSettingsSync].filter(Boolean));
  app.addHook("onClose", async () => {
    await Promise.all([...closeables].map((closeable) => closeable?.close?.()));
  });

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/addons",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
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

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/guest-form",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingGuestFormSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingGuestFormSettingsReadModel | null;
      try {
        settings = await repository.findGuestFormSettingsByHotelId(hotelId);
      } catch {
        return sendBookingGuestFormSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking guest-form settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingGuestFormSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel guest-form settings not found.",
        });
      }

      return toGuestFormSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/benefits",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingBenefitsSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingBenefitsSettingsReadModel | null;
      try {
        settings = await repository.findBenefitsSettingsByHotelId(hotelId);
      } catch {
        return sendBookingBenefitsSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking benefits settings are unavailable.",
        });
      }

      // Legacy `/admin/benefits` compatibility: a missing hotel row or unset
      // benefits value is an empty hotel-level list, never a 404.
      return toBenefitsSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/localization",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingLocalizationSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingLocalizationSettingsReadModel | null;
      try {
        settings = await repository.findLocalizationSettingsByHotelId(hotelId);
      } catch {
        return sendBookingLocalizationSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking localization settings are unavailable.",
        });
      }

      if (!settings) {
        return sendBookingLocalizationSettingsError(reply, {
          statusCode: 404,
          code: "not_found",
          category: "read_model",
          message: "Booking hotel localization settings not found.",
        });
      }

      return toLocalizationSettingsResponse(settings);
    },
  );

  app.get<{ Params: BookingHotelParams }>(
    "/hotels/:hotelId/settings/room-filters",
    async (request, reply) => {
      const { hotelId } = request.params;

      try {
        enforceBookingSettingsPolicy(request, hotelId);
      } catch (error) {
        const contractError = toBookingSettingsAccessError(error, request, hotelId);
        if (contractError) {
          return sendBookingRoomFilterSettingsError(reply, contractError);
        }
        throw error;
      }

      let settings: BookingRoomFilterSettingsReadModel | null;
      try {
        settings = (await repository.findRoomFilterSettingsByHotelId?.(hotelId)) ?? null;
      } catch {
        return sendBookingRoomFilterSettingsError(reply, {
          statusCode: 500,
          code: "read_model_unavailable",
          category: "read_model",
          message: "Booking room-filter settings are unavailable.",
        });
      }

      // Legacy design-settings compatibility: missing hotel rows read as empty
      // filter settings after authorization, not as not-found errors.
      return toRoomFilterSettingsResponse(settings);
    },
  );

  if (!writeRepository) return;

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/addons",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseAddonSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateAddonSettingsByHotelId(hotelId, settings),
        toResponse: toAddonSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/guest-form",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseGuestFormSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateGuestFormSettingsByHotelId(hotelId, settings),
        afterWrite: async (hotelId, _settings, stored, request) => {
          if (!guestFormSettingsSync) return;
          try {
            await guestFormSettingsSync.syncGuestFormSettingsByHotelId(
              hotelId,
              toGuestFormSettingsResponse(stored),
              request.headers.authorization,
            );
          } catch (error) {
            request.log.warn(
              { err: error, hotelId },
              "PMS guest-form settings sync failed after Booking settings write",
            );
          }
        },
        toResponse: toGuestFormSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/benefits",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseBenefitsSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateBenefitsSettingsByHotelId(hotelId, settings),
        toResponse: toBenefitsSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/localization",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseLocalizationSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateLocalizationSettingsByHotelId(hotelId, settings),
        toResponse: toLocalizationSettingsResponse,
      }),
  );

  app.put<{ Params: BookingHotelParams; Body: unknown }>(
    "/hotels/:hotelId/settings/room-filters",
    async (request, reply) =>
      handleBookingSettingsWrite({
        request,
        reply,
        parseBody: parseRoomFilterSettingsWriteBody,
        write: (hotelId, settings) =>
          writeRepository.updateRoomFilterSettingsByHotelId(hotelId, settings),
        toResponse: toRoomFilterSettingsResponse,
      }),
  );
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; details: string[] };

async function handleBookingSettingsWrite<TBody, TStored>(input: {
  request: FastifyRequest<{ Params: BookingHotelParams; Body: unknown }>;
  reply: FastifyReply;
  parseBody(body: unknown): ValidationResult<TBody>;
  write(hotelId: string, settings: TBody): Promise<TStored | null>;
  afterWrite?(
    hotelId: string,
    settings: TBody,
    stored: TStored,
    request: FastifyRequest<{ Params: BookingHotelParams; Body: unknown }>,
  ): Promise<void>;
  toResponse(settings: TStored): unknown;
}): Promise<unknown> {
  const { hotelId } = input.request.params;

  try {
    enforceBookingSettingsPolicy(input.request, hotelId);
  } catch (error) {
    const contractError = toBookingSettingsAccessError(error, input.request, hotelId);
    if (contractError) {
      return sendBookingSettingsWriteError(input.reply, contractError);
    }
    throw error;
  }

  const parsed = input.parseBody(input.request.body);
  if (!parsed.ok) {
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking settings payload is invalid.",
      details: parsed.details,
    });
  }

  let stored: TStored | null;
  try {
    stored = await input.write(hotelId, parsed.value);
  } catch {
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 500,
      code: "write_model_unavailable",
      category: "write_model",
      message: "Booking settings could not be saved.",
    });
  }

  if (!stored) {
    return sendBookingSettingsWriteError(input.reply, {
      statusCode: 404,
      code: "not_found",
      category: "write_model",
      message: "Booking settings target not found.",
    });
  }

  await input.afterWrite?.(hotelId, parsed.value, stored, input.request);

  return input.toResponse(stored);
}

function parseAddonSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingAddonSettingsBody> {
  const parsed = expectStrictObject(body, ["showAddonsStep", "groupAddonsByCategory"]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const showAddonsStep = expectBoolean(parsed.value, "showAddonsStep", details);
  const groupAddonsByCategory = expectBoolean(parsed.value, "groupAddonsByCategory", details);

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      showAddonsStep,
      groupAddonsByCategory,
    },
  };
}

function parseGuestFormSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingGuestFormSettingsBody> {
  const parsed = expectStrictObject(body, [
    "specialRequestsEnabled",
    "arrivalTimeEnabled",
    "guestCountEnabled",
  ]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const specialRequestsEnabled = expectBoolean(parsed.value, "specialRequestsEnabled", details);
  const arrivalTimeEnabled = expectBoolean(parsed.value, "arrivalTimeEnabled", details);
  const guestCountEnabled = expectBoolean(parsed.value, "guestCountEnabled", details);

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      specialRequestsEnabled,
      arrivalTimeEnabled,
      guestCountEnabled,
    },
  };
}

function parseBenefitsSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingBenefitsSettingsBody> {
  const parsed = expectStrictObject(body, ["benefits"]);
  if (!parsed.ok) return parsed;

  const rawBenefits = parsed.value.benefits;
  if (!Array.isArray(rawBenefits)) {
    return { ok: false, details: ["benefits must be an array."] };
  }

  const benefits: string[] = [];
  const seen = new Set<string>();
  const details: string[] = [];
  rawBenefits.forEach((benefit, index) => {
    if (typeof benefit !== "string") {
      details.push(`benefits.${index} must be a string.`);
      return;
    }

    const normalized = benefit.trim();
    if (!normalized) {
      details.push(`benefits.${index} must not be empty.`);
      return;
    }
    if (seen.has(normalized)) {
      details.push(`benefits.${index} duplicates another benefit.`);
      return;
    }

    seen.add(normalized);
    benefits.push(normalized);
  });

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      benefits,
    },
  };
}

function parseLocalizationSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingLocalizationSettingsBody> {
  const parsed = expectStrictObject(body, [
    "defaultCurrency",
    "defaultLanguage",
    "supportedCurrencies",
    "supportedLanguages",
  ]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const defaultCurrency = normalizeCurrencyCode(
    expectString(parsed.value, "defaultCurrency", details),
    "defaultCurrency",
    details,
  );
  const defaultLanguage = normalizeLanguageCode(
    expectString(parsed.value, "defaultLanguage", details),
    "defaultLanguage",
    details,
  );
  const supportedCurrencies = normalizeCurrencyList(
    parsed.value.supportedCurrencies,
    "supportedCurrencies",
    defaultCurrency,
    details,
  );
  const supportedLanguages = normalizeLanguageList(
    parsed.value.supportedLanguages,
    "supportedLanguages",
    defaultLanguage,
    details,
  );

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      defaultCurrency,
      defaultLanguage,
      supportedCurrencies,
      supportedLanguages,
    },
  };
}

function parseRoomFilterSettingsWriteBody(
  body: unknown,
): ValidationResult<UpdateBookingRoomFilterSettingsBody> {
  const parsed = expectStrictObject(body, ["bookingFilters", "customFilters", "filterRooms"]);
  if (!parsed.ok) return parsed;

  const details: string[] = [];
  const bookingFilters = normalizeStringArray(
    parsed.value.bookingFilters,
    "bookingFilters",
    details,
  );
  const allowedFilters = new Set(bookingFilters);
  const customFilters = normalizeStringRecord(parsed.value.customFilters, "customFilters", details);
  const filterRooms = normalizeStringArrayRecord(parsed.value.filterRooms, "filterRooms", details);

  for (const key of Object.keys(customFilters)) {
    if (!allowedFilters.has(key)) {
      details.push(`customFilters.${key} must be present in bookingFilters.`);
    }
  }
  for (const key of Object.keys(filterRooms)) {
    if (!allowedFilters.has(key)) {
      details.push(`filterRooms.${key} must be present in bookingFilters.`);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    value: {
      bookingFilters,
      customFilters,
      filterRooms,
    },
  };
}

export function toAddonSettingsResponse(
  settings: BookingAddonSettingsReadModel,
): BookingAddonSettingsResponse {
  return {
    showAddonsStep: settings.showAddonsStep ?? true,
    groupAddonsByCategory: settings.groupAddonsByCategory ?? true,
  };
}

export function toGuestFormSettingsResponse(
  settings: BookingGuestFormSettingsReadModel,
): BookingGuestFormSettingsResponse {
  return {
    specialRequestsEnabled: settings.specialRequestsEnabled ?? true,
    arrivalTimeEnabled: settings.arrivalTimeEnabled ?? false,
    guestCountEnabled: settings.guestCountEnabled ?? false,
  };
}

export function toBenefitsSettingsResponse(
  settings: BookingBenefitsSettingsReadModel | null,
): BookingBenefitsSettingsResponse {
  return {
    benefits: parseBenefitsValue(settings?.benefits),
  };
}

export function toLocalizationSettingsResponse(
  settings: BookingLocalizationSettingsReadModel,
): BookingLocalizationSettingsResponse {
  return {
    defaultCurrency: settings.defaultCurrency ?? "EUR",
    defaultLanguage: settings.defaultLanguage ?? "en",
    supportedCurrencies: parseStringList(settings.supportedCurrencies, []),
    supportedLanguages: parseStringList(settings.supportedLanguages, ["en"]),
  };
}

export function toRoomFilterSettingsResponse(
  settings: BookingRoomFilterSettingsReadModel | null,
): BookingRoomFilterSettingsResponse {
  return {
    bookingFilters: parseLooseStringList(settings?.bookingFilters),
    customFilters: parseStringRecord(settings?.customFilters),
    filterRooms: parseStringArrayRecord(settings?.filterRooms),
  };
}

// Mirrors the legacy booking-api `parse_json` handling of
// `booking_hotels.benefits`: the JSONB value may arrive as a native array, a
// JSON-encoded string, or NULL. NULL, malformed, and non-list values all
// default to an empty list, and non-string entries are dropped rather than
// failing the read.
function parseBenefitsValue(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseStringList(value: unknown, fallback: string[]): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  if (!Array.isArray(parsed)) return fallback;
  if (!parsed.every((entry) => typeof entry === "string")) return fallback;
  return parsed;
}

function parseLooseStringList(value: unknown): string[] {
  const parsed = parseJsonIfString(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseStringRecord(value: unknown): Record<string, string> {
  const parsed = parseJsonIfString(value);
  if (!isPlainRecord(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function parseStringArrayRecord(value: unknown): Record<string, string[]> {
  const parsed = parseJsonIfString(value);
  if (!isPlainRecord(parsed)) return {};

  return Object.fromEntries(
    Object.entries(parsed).map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? entry.filter((roomId): roomId is string => typeof roomId === "string")
        : [],
    ]),
  );
}

function expectStrictObject(
  value: unknown,
  expectedKeys: readonly string[],
): ValidationResult<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return { ok: false, details: ["body must be an object."] };
  }

  const details: string[] = [];
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!expected.has(key)) {
      details.push(`${key} is not allowed.`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      details.push(`${key} is required.`);
    }
  }

  if (details.length > 0) return { ok: false, details };
  return { ok: true, value };
}

function expectBoolean(record: Record<string, unknown>, key: string, details: string[]): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    details.push(`${key} must be a boolean.`);
    return false;
  }
  return value;
}

function expectString(
  record: Record<string, unknown>,
  key: string,
  details: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    details.push(`${key} must be a string.`);
    return undefined;
  }
  return value;
}

function normalizeCurrencyCode(value: string | undefined, path: string, details: string[]): string {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(normalized)) {
    details.push(`${path} must be a three-letter currency code.`);
  }
  return normalized;
}

function normalizeLanguageCode(value: string | undefined, path: string, details: string[]): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(normalized)) {
    details.push(`${path} must be a non-empty language code.`);
  }
  return normalized;
}

function normalizeCurrencyList(
  value: unknown,
  path: string,
  defaultCurrency: string,
  details: string[],
): string[] {
  return normalizeUniqueCodeList(value, path, defaultCurrency, details, (entry, entryPath) =>
    normalizeCurrencyCode(entry, entryPath, details),
  );
}

function normalizeLanguageList(
  value: unknown,
  path: string,
  defaultLanguage: string,
  details: string[],
): string[] {
  return normalizeUniqueCodeList(value, path, defaultLanguage, details, (entry, entryPath) =>
    normalizeLanguageCode(entry, entryPath, details),
  );
}

function normalizeUniqueCodeList(
  value: unknown,
  path: string,
  defaultValue: string,
  details: string[],
  normalize: (value: string | undefined, path: string) => string,
): string[] {
  if (!Array.isArray(value)) {
    details.push(`${path} must be an array.`);
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`${path}.${index} must be a string.`);
      return;
    }

    const normalized = normalize(entry, `${path}.${index}`);
    if (!normalized || normalized === defaultValue) return;
    if (seen.has(normalized)) {
      details.push(`${path}.${index} duplicates another code.`);
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function normalizeStringArray(value: unknown, path: string, details: string[]): string[] {
  if (!Array.isArray(value)) {
    details.push(`${path} must be an array.`);
    return [];
  }

  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      details.push(`${path}.${index} must be a string.`);
      return;
    }

    const normalized = entry.trim();
    if (!normalized) {
      details.push(`${path}.${index} must not be empty.`);
      return;
    }
    result.push(normalized);
  });
  return result;
}

function normalizeStringRecord(
  value: unknown,
  path: string,
  details: string[],
): Record<string, string> {
  if (!isPlainRecord(value)) {
    details.push(`${path} must be an object.`);
    return {};
  }

  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      details.push(`${path} contains an empty key.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      details.push(`${path}.${key} duplicates another key after trimming.`);
      continue;
    }
    if (typeof rawValue !== "string") {
      details.push(`${path}.${key} must be a string.`);
      continue;
    }

    const normalizedValue = rawValue.trim();
    if (!normalizedValue) {
      details.push(`${path}.${key} must not be empty.`);
      continue;
    }
    result[key] = normalizedValue;
  }
  return result;
}

function normalizeStringArrayRecord(
  value: unknown,
  path: string,
  details: string[],
): Record<string, string[]> {
  if (!isPlainRecord(value)) {
    details.push(`${path} must be an object.`);
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) {
      details.push(`${path} contains an empty key.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      details.push(`${path}.${key} duplicates another key after trimming.`);
      continue;
    }
    result[key] = normalizeStringArray(rawValue, `${path}.${key}`, details);
  }
  return result;
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sendBookingAddonSettingsError(
  reply: FastifyReply,
  error: BookingAddonSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingGuestFormSettingsError(
  reply: FastifyReply,
  error: BookingGuestFormSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingBenefitsSettingsError(
  reply: FastifyReply,
  error: BookingBenefitsSettingsError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingLocalizationSettingsError(
  reply: FastifyReply,
  error: BookingLocalizationSettingsError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingRoomFilterSettingsError(
  reply: FastifyReply,
  error: BookingRoomFilterSettingsError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendBookingSettingsWriteError(
  reply: FastifyReply,
  error: BookingSettingsWriteError | BookingSettingsAccessError,
): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

type BookingSettingsAccessError = {
  statusCode: 401 | 403;
  code: BookingSettingsAuthorizationErrorCode | "unauthenticated";
  category: "authentication" | "authorization";
  message: string;
};

type BookingSettingsAuthorizationErrorCode =
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access";

function enforceBookingSettingsPolicy(request: FastifyRequest, hotelId: string): void {
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
}

function toBookingSettingsAccessError(
  error: unknown,
  request: FastifyRequest,
  hotelId: string,
): BookingSettingsAccessError | null {
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

  const code = toBookingSettingsAuthorizationErrorCode(error.message, request, hotelId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toBookingSettingsAuthorizationMessage(code),
  };
}

function toBookingSettingsAuthorizationErrorCode(
  message: string,
  request: FastifyRequest,
  hotelId: string,
): BookingSettingsAuthorizationErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactiveBookingSettingsEntitlement(request, hotelId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toBookingSettingsAuthorizationMessage(
  code: BookingSettingsAuthorizationErrorCode,
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
