import { apiClient, ApiErrorResponse, type ApiClient } from "./client";

export const BOOKING_BENEFITS_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/benefits";

type BookingBenefitsSettingsApiClient = Pick<ApiClient, "get">;

export interface GetBookingBenefitsSettingsInput {
  hotelId: string;
}

export interface BookingBenefitsSettings {
  benefits: string[];
}

export type BookingBenefitsSettingsErrorCategory =
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

export class BookingBenefitsSettingsClientError extends Error {
  statusCode: 401 | 403 | 500;
  code: BookingBenefitsSettingsErrorCode;
  category: BookingBenefitsSettingsErrorCategory;
  detail: string;

  constructor(input: {
    statusCode: 401 | 403 | 500;
    code: BookingBenefitsSettingsErrorCode;
    category: BookingBenefitsSettingsErrorCategory;
    detail: string;
  }) {
    super(input.detail);
    this.name = "BookingBenefitsSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
  }
}

export async function getBookingBenefitsSettings(
  input: GetBookingBenefitsSettingsInput,
  client: BookingBenefitsSettingsApiClient = apiClient,
): Promise<BookingBenefitsSettings> {
  try {
    return await client.get<BookingBenefitsSettings>(buildBookingBenefitsSettingsEndpoint(input));
  } catch (error) {
    throw toBookingBenefitsSettingsClientError(error);
  }
}

export function buildBookingBenefitsSettingsEndpoint(
  input: GetBookingBenefitsSettingsInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingBenefitsSettingsClientError({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_BENEFITS_SETTINGS_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingBenefitsSettingsClientError(
  error: unknown,
): BookingBenefitsSettingsClientError {
  if (error instanceof BookingBenefitsSettingsClientError) {
    return error;
  }

  if (error instanceof ApiErrorResponse) {
    return mapApiError(error);
  }

  return new BookingBenefitsSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail: error instanceof Error ? error.message : "Booking benefits settings are unavailable.",
  });
}

function mapApiError(error: ApiErrorResponse): BookingBenefitsSettingsClientError {
  const contractError = readContractErrorBody(error);
  if (contractError) {
    return new BookingBenefitsSettingsClientError(contractError);
  }

  const detail = readApiErrorDetail(error);

  if (error.status === 401) {
    return new BookingBenefitsSettingsClientError({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    });
  }

  if (error.status === 403) {
    return new BookingBenefitsSettingsClientError({
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    });
  }

  return new BookingBenefitsSettingsClientError({
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    detail,
  });
}

function readContractErrorBody(error: ApiErrorResponse): {
  statusCode: 401 | 403 | 500;
  code: BookingBenefitsSettingsErrorCode;
  category: BookingBenefitsSettingsErrorCategory;
  detail: string;
} | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingBenefitsSettingsErrorCode(data.code)) return null;
  if (!isBookingBenefitsSettingsErrorCategory(data.category)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Booking benefits settings are unavailable.",
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
  return error.message || "Booking benefits settings are unavailable.";
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
  BookingBenefitsSettingsErrorCode,
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

function isBookingBenefitsSettingsErrorCode(
  value: unknown,
): value is BookingBenefitsSettingsErrorCode {
  return (
    value === "unauthenticated" ||
    value === "missing_permission" ||
    value === "missing_entitlement" ||
    value === "inactive_entitlement" ||
    value === "missing_resource_access" ||
    value === "read_model_unavailable"
  );
}

function isBookingBenefitsSettingsErrorCategory(
  value: unknown,
): value is BookingBenefitsSettingsErrorCategory {
  return value === "authentication" || value === "authorization" || value === "read_model";
}
