import { apiClient, ApiErrorResponse, type ApiClient } from "./client";

export const BOOKING_ROOM_FILTER_SETTINGS_PATH =
  "/api/booking/hotels/:hotelId/settings/room-filters";

type BookingRoomFilterSettingsApiClient = Pick<ApiClient, "get">;

export interface GetBookingRoomFilterSettingsInput {
  hotelId: string;
}

export interface BookingRoomFilterSettings {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
}

export type BookingRoomFilterSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingRoomFilterSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

export class BookingRoomFilterSettingsClientError extends Error {
  statusCode: 401 | 403 | 500;
  code: BookingRoomFilterSettingsErrorCode;
  category: BookingRoomFilterSettingsErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 401 | 403 | 500;
    code: BookingRoomFilterSettingsErrorCode;
    category: BookingRoomFilterSettingsErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingRoomFilterSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingRoomFilterSettings(
  input: GetBookingRoomFilterSettingsInput,
  client: BookingRoomFilterSettingsApiClient = apiClient,
): Promise<BookingRoomFilterSettings> {
  try {
    return await client.get<BookingRoomFilterSettings>(
      buildBookingRoomFilterSettingsEndpoint(input),
    );
  } catch (error) {
    throw toBookingRoomFilterSettingsClientError(error);
  }
}

export function buildBookingRoomFilterSettingsEndpoint(
  input: GetBookingRoomFilterSettingsInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingRoomFilterSettingsClientError({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_ROOM_FILTER_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingRoomFilterSettingsClientError(
  error: unknown,
): BookingRoomFilterSettingsClientError {
  if (error instanceof BookingRoomFilterSettingsClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingRoomFilterSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail:
      error instanceof Error ? error.message : "Booking room-filter settings are unavailable.",
  });
}

function mapApiError(error: ApiErrorResponse): BookingRoomFilterSettingsClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingRoomFilterSettingsClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingRoomFilterSettingsClientError({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingRoomFilterSettingsClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  return new BookingRoomFilterSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 401 | 403 | 500;
  code: BookingRoomFilterSettingsErrorCode;
  category: BookingRoomFilterSettingsErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingRoomFilterSettingsErrorCode(data.code)) return null;
  if (!isBookingRoomFilterSettingsErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking room-filter settings are unavailable.",
  };
}

function readApiErrorDetail(error: ApiErrorResponse): string {
  const data = error.data as Partial<{ detail: unknown; message: unknown }> | null;
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const message = detail.map(readApiErrorDetailEntry).filter(Boolean).join(", ");
    if (message) return message;
  }
  if (typeof data?.message === "string") return data.message;
  return error.message || "Booking room-filter settings are unavailable.";
}

function readApiErrorDetailEntry(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "msg" in entry) {
    const message = (entry as { msg?: unknown }).msg;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function toAuthorizationErrorCode(
  detail: string,
): Extract<
  BookingRoomFilterSettingsErrorCode,
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

function toContractStatusCode(bodyStatusCode: unknown, responseStatus: number): 401 | 403 | 500 {
  if (bodyStatusCode === 401 || bodyStatusCode === 403 || bodyStatusCode === 500) {
    return bodyStatusCode;
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return responseStatus;
  }
  return 500;
}

function isBookingRoomFilterSettingsErrorCode(
  value: unknown,
): value is BookingRoomFilterSettingsErrorCode {
  return (
    value === "unauthenticated" ||
    value === "missing_permission" ||
    value === "missing_entitlement" ||
    value === "inactive_entitlement" ||
    value === "missing_resource_access" ||
    value === "read_model_unavailable"
  );
}

function isBookingRoomFilterSettingsErrorCategory(
  value: unknown,
): value is BookingRoomFilterSettingsErrorCategory {
  return value === "authentication" || value === "authorization" || value === "read_model";
}
