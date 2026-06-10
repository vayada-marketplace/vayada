import { apiClient, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_LOCALIZATION_SETTINGS_PATH =
  "/api/booking/hotels/:hotelId/settings/localization";

type BookingLocalizationSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingLocalizationSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface GetBookingLocalizationSettingsInput {
  hotelId: string;
}

export interface BookingLocalizationSettings {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
}

export type UpdateBookingLocalizationSettingsBody = BookingLocalizationSettings;

export interface UpdateBookingLocalizationSettingsInput {
  hotelId: string;
  body: UpdateBookingLocalizationSettingsBody;
}

export type BookingLocalizationSettingsErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "read_model"
>;
export type BookingLocalizationSettingsWriteErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "validation" | "write_model"
>;
export type BookingLocalizationSettingsClientErrorCategory = BookingSettingsClientErrorCategory;

export type BookingLocalizationSettingsErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable"
>;
export type BookingLocalizationSettingsWriteErrorCode = Extract<
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
export type BookingLocalizationSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingLocalizationSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingLocalizationSettingsClientErrorCode;
  category: BookingLocalizationSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingLocalizationSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingLocalizationSettings(
  input: GetBookingLocalizationSettingsInput,
  client: BookingLocalizationSettingsReadApiClient = apiClient,
): Promise<BookingLocalizationSettings> {
  try {
    return await client.get<BookingLocalizationSettings>(
      buildBookingLocalizationSettingsEndpoint(input),
    );
  } catch (error) {
    throw toBookingLocalizationSettingsClientError(error);
  }
}

export async function updateBookingLocalizationSettings(
  input: UpdateBookingLocalizationSettingsInput,
  client: BookingLocalizationSettingsWriteApiClient = apiClient,
): Promise<BookingLocalizationSettings> {
  try {
    return await client.put<BookingLocalizationSettings>(
      buildBookingLocalizationSettingsEndpoint(input),
      input.body,
    );
  } catch (error) {
    throw toBookingLocalizationSettingsClientError(error, "write");
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
  operation: BookingSettingsClientOperation = "read",
): BookingLocalizationSettingsClientError {
  if (error instanceof BookingLocalizationSettingsClientError) {
    return error;
  }

  return new BookingLocalizationSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking localization settings are unavailable.",
      readNotFound: true,
    }),
  );
}
