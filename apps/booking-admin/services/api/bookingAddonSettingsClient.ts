import { apiClient, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_ADDON_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/addons";

type BookingAddonSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingAddonSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface GetBookingAddonSettingsInput {
  hotelId: string;
}

export interface BookingAddonSettings {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export type UpdateBookingAddonSettingsBody = BookingAddonSettings;

export interface UpdateBookingAddonSettingsInput {
  hotelId: string;
  body: UpdateBookingAddonSettingsBody;
}

export type BookingAddonSettingsErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "read_model"
>;
export type BookingAddonSettingsWriteErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "validation" | "write_model"
>;
export type BookingAddonSettingsClientErrorCategory = BookingSettingsClientErrorCategory;

export type BookingAddonSettingsErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable"
>;
export type BookingAddonSettingsWriteErrorCode = Extract<
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
export type BookingAddonSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingAddonSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingAddonSettingsClientErrorCode;
  category: BookingAddonSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingAddonSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingAddonSettings(
  input: GetBookingAddonSettingsInput,
  client: BookingAddonSettingsReadApiClient = apiClient,
): Promise<BookingAddonSettings> {
  try {
    return await client.get<BookingAddonSettings>(buildBookingAddonSettingsEndpoint(input));
  } catch (error) {
    throw toBookingAddonSettingsClientError(error);
  }
}

export async function updateBookingAddonSettings(
  input: UpdateBookingAddonSettingsInput,
  client: BookingAddonSettingsWriteApiClient = apiClient,
): Promise<BookingAddonSettings> {
  try {
    return await client.put<BookingAddonSettings>(
      buildBookingAddonSettingsEndpoint(input),
      input.body,
    );
  } catch (error) {
    throw toBookingAddonSettingsClientError(error, "write");
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

export function toBookingAddonSettingsClientError(
  error: unknown,
  operation: BookingSettingsClientOperation = "read",
): BookingAddonSettingsClientError {
  if (error instanceof BookingAddonSettingsClientError) {
    return error;
  }

  return new BookingAddonSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking add-on settings are unavailable.",
      readNotFound: true,
    }),
  );
}
