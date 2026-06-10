import { apiClient, ApiErrorResponse, type ApiClient } from "./client";

export const BOOKING_GUEST_FORM_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/guest-form";

type BookingGuestFormSettingsApiClient = Pick<ApiClient, "get">;

export interface GetBookingGuestFormSettingsInput {
  hotelId: string;
}

export interface BookingGuestFormSettings {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
}

export type BookingGuestFormSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingGuestFormSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export class BookingGuestFormSettingsClientError extends Error {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingGuestFormSettingsErrorCode;
  category: BookingGuestFormSettingsErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 401 | 403 | 404 | 500;
    code: BookingGuestFormSettingsErrorCode;
    category: BookingGuestFormSettingsErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingGuestFormSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingGuestFormSettings(
  input: GetBookingGuestFormSettingsInput,
  client: BookingGuestFormSettingsApiClient = apiClient,
): Promise<BookingGuestFormSettings> {
  try {
    return await client.get<BookingGuestFormSettings>(buildBookingGuestFormSettingsEndpoint(input));
  } catch (error) {
    throw toBookingGuestFormSettingsClientError(error);
  }
}

export function buildBookingGuestFormSettingsEndpoint(
  input: GetBookingGuestFormSettingsInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingGuestFormSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_GUEST_FORM_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingGuestFormSettingsClientError(
  error: unknown,
): BookingGuestFormSettingsClientError {
  if (error instanceof BookingGuestFormSettingsClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingGuestFormSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail: error instanceof Error ? error.message : "Booking guest-form settings are unavailable.",
  });
}

function mapApiError(error: ApiErrorResponse): BookingGuestFormSettingsClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingGuestFormSettingsClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingGuestFormSettingsClientError({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingGuestFormSettingsClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  if (error.status === 404) {
    return new BookingGuestFormSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail,
    });
  }

  return new BookingGuestFormSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingGuestFormSettingsErrorCode;
  category: BookingGuestFormSettingsErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingGuestFormSettingsErrorCode(data.code)) return null;
  if (!isBookingGuestFormSettingsErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking guest-form settings are unavailable.",
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
  return error.message || "Booking guest-form settings are unavailable.";
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
  BookingGuestFormSettingsErrorCode,
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

function isBookingGuestFormSettingsErrorCode(
  value: unknown,
): value is BookingGuestFormSettingsErrorCode {
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

function isBookingGuestFormSettingsErrorCategory(
  value: unknown,
): value is BookingGuestFormSettingsErrorCategory {
  return value === "authentication" || value === "authorization" || value === "read_model";
}
