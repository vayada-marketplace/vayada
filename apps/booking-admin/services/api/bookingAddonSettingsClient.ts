import { apiClient, ApiErrorResponse, type ApiClient } from "./client";

export const BOOKING_ADDON_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/addons";

type BookingAddonSettingsApiClient = Pick<ApiClient, "get">;

export interface GetBookingAddonSettingsInput {
  hotelId: string;
}

export interface BookingAddonSettings {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export type BookingAddonSettingsErrorCategory = "authentication" | "authorization" | "read_model";

export type BookingAddonSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export class BookingAddonSettingsClientError extends Error {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 401 | 403 | 404 | 500;
    code: BookingAddonSettingsErrorCode;
    category: BookingAddonSettingsErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingAddonSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingAddonSettings(
  input: GetBookingAddonSettingsInput,
  client: BookingAddonSettingsApiClient = apiClient,
): Promise<BookingAddonSettings> {
  try {
    return await client.get<BookingAddonSettings>(buildBookingAddonSettingsEndpoint(input));
  } catch (error) {
    throw toBookingAddonSettingsClientError(error);
  }
}

export function buildBookingAddonSettingsEndpoint(input: GetBookingAddonSettingsInput): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingAddonSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_ADDON_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingAddonSettingsClientError(error: unknown): BookingAddonSettingsClientError {
  if (error instanceof BookingAddonSettingsClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingAddonSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail: error instanceof Error ? error.message : "Booking add-on settings are unavailable.",
  });
}

function mapApiError(error: ApiErrorResponse): BookingAddonSettingsClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingAddonSettingsClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingAddonSettingsClientError({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingAddonSettingsClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  if (error.status === 404) {
    return new BookingAddonSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail,
    });
  }

  return new BookingAddonSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingAddonSettingsErrorCode(data.code)) return null;
  if (!isBookingAddonSettingsErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking add-on settings are unavailable.",
  };
}

function readApiErrorDetail(error: ApiErrorResponse): string {
  const data = error.data as Partial<{ detail: unknown; message: unknown }> | null;
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((entry) => entry.msg).join(", ");
  if (typeof data?.message === "string") return data.message;
  return error.message || "Booking add-on settings are unavailable.";
}

function toAuthorizationErrorCode(
  detail: string,
): Extract<
  BookingAddonSettingsErrorCode,
  "missing_permission" | "missing_entitlement" | "inactive_entitlement" | "missing_resource_access"
> {
  const normalized = detail.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (
    normalized.includes("inactive") ||
    normalized.includes("suspended") ||
    normalized.includes("disabled") ||
    normalized.includes("not active")
  ) {
    return "inactive_entitlement";
  }
  if (normalized.includes("entitlement")) return "missing_entitlement";
  return "missing_resource_access";
}

function toContractStatusCode(
  bodyStatusCode: unknown,
  responseStatus: number,
): 401 | 403 | 404 | 500 {
  if (
    bodyStatusCode === 401 ||
    bodyStatusCode === 403 ||
    bodyStatusCode === 404 ||
    bodyStatusCode === 500
  ) {
    return bodyStatusCode;
  }
  if (responseStatus === 401 || responseStatus === 403 || responseStatus === 404) {
    return responseStatus;
  }
  return 500;
}

function isBookingAddonSettingsErrorCode(value: unknown): value is BookingAddonSettingsErrorCode {
  return (
    value === "unauthenticated" ||
    value === "missing_permission" ||
    value === "missing_entitlement" ||
    value === "inactive_entitlement" ||
    value === "missing_resource_access" ||
    value === "not_found" ||
    value === "read_model_unavailable"
  );
}

function isBookingAddonSettingsErrorCategory(
  value: unknown,
): value is BookingAddonSettingsErrorCategory {
  return value === "authentication" || value === "authorization" || value === "read_model";
}
