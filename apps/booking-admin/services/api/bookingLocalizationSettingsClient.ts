import { apiClient, ApiErrorResponse, type ApiClient } from "./client";

export const BOOKING_LOCALIZATION_SETTINGS_PATH =
  "/api/booking/hotels/:hotelId/settings/localization";

type BookingLocalizationSettingsApiClient = Pick<ApiClient, "get">;

export interface GetBookingLocalizationSettingsInput {
  hotelId: string;
}

export interface BookingLocalizationSettings {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
}

export type BookingLocalizationSettingsErrorCategory =
  | "authentication"
  | "authorization"
  | "read_model";

export type BookingLocalizationSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

export class BookingLocalizationSettingsClientError extends Error {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLocalizationSettingsErrorCode;
  category: BookingLocalizationSettingsErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 401 | 403 | 404 | 500;
    code: BookingLocalizationSettingsErrorCode;
    category: BookingLocalizationSettingsErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingLocalizationSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingLocalizationSettings(
  input: GetBookingLocalizationSettingsInput,
  client: BookingLocalizationSettingsApiClient = apiClient,
): Promise<BookingLocalizationSettings> {
  try {
    return await client.get<BookingLocalizationSettings>(
      buildBookingLocalizationSettingsEndpoint(input),
    );
  } catch (error) {
    throw toBookingLocalizationSettingsClientError(error);
  }
}

export function buildBookingLocalizationSettingsEndpoint(
  input: GetBookingLocalizationSettingsInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingLocalizationSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_LOCALIZATION_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingLocalizationSettingsClientError(
  error: unknown,
): BookingLocalizationSettingsClientError {
  if (error instanceof BookingLocalizationSettingsClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingLocalizationSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail:
      error instanceof Error ? error.message : "Booking localization settings are unavailable.",
  });
}

function mapApiError(error: ApiErrorResponse): BookingLocalizationSettingsClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingLocalizationSettingsClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingLocalizationSettingsClientError({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingLocalizationSettingsClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  if (error.status === 404) {
    return new BookingLocalizationSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail,
    });
  }

  return new BookingLocalizationSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLocalizationSettingsErrorCode;
  category: BookingLocalizationSettingsErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingLocalizationSettingsErrorCode(data.code)) return null;
  if (!isBookingLocalizationSettingsErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking localization settings are unavailable.",
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
  return error.message || "Booking localization settings are unavailable.";
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
  BookingLocalizationSettingsErrorCode,
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

function isBookingLocalizationSettingsErrorCode(
  value: unknown,
): value is BookingLocalizationSettingsErrorCode {
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

function isBookingLocalizationSettingsErrorCategory(
  value: unknown,
): value is BookingLocalizationSettingsErrorCategory {
  return value === "authentication" || value === "authorization" || value === "read_model";
}
