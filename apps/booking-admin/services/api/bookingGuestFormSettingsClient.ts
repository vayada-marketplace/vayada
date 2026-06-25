import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_GUEST_FORM_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/guest-form";

type BookingGuestFormSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingGuestFormSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface GetBookingGuestFormSettingsInput {
  hotelId: string;
}

export interface BookingGuestFormSettings {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
  adultAgeThreshold: number;
  childrenEnabled: boolean;
}

export type UpdateBookingGuestFormSettingsBody = BookingGuestFormSettings;

export interface UpdateBookingGuestFormSettingsInput {
  hotelId: string;
  body: UpdateBookingGuestFormSettingsBody;
}

export type BookingGuestFormSettingsErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "read_model"
>;
export type BookingGuestFormSettingsWriteErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "validation" | "write_model"
>;
export type BookingGuestFormSettingsClientErrorCategory = BookingSettingsClientErrorCategory;

export type BookingGuestFormSettingsErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable"
>;
export type BookingGuestFormSettingsWriteErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "not_found"
  | "write_model_unavailable"
>;
export type BookingGuestFormSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingGuestFormSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingGuestFormSettingsClientErrorCode;
  category: BookingGuestFormSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingGuestFormSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingGuestFormSettings(
  input: GetBookingGuestFormSettingsInput,
  client: BookingGuestFormSettingsReadApiClient = apiClient,
): Promise<BookingGuestFormSettings> {
  try {
    return await client.get<BookingGuestFormSettings>(
      buildBookingGuestFormSettingsEndpoint(input),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingGuestFormSettingsClientError(error);
  }
}

export async function updateBookingGuestFormSettings(
  input: UpdateBookingGuestFormSettingsInput,
  client: BookingGuestFormSettingsWriteApiClient = apiClient,
): Promise<BookingGuestFormSettings> {
  try {
    return await client.put<BookingGuestFormSettings>(
      buildBookingGuestFormSettingsEndpoint(input),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingGuestFormSettingsClientError(error, "write");
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
  operation: BookingSettingsClientOperation = "read",
): BookingGuestFormSettingsClientError {
  if (error instanceof BookingGuestFormSettingsClientError) {
    return error;
  }

  return new BookingGuestFormSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking guest-form settings are unavailable.",
      readNotFound: true,
    }),
  );
}
