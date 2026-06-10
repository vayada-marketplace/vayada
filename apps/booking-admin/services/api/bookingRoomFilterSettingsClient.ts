import { apiClient, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_ROOM_FILTER_SETTINGS_PATH =
  "/api/booking/hotels/:hotelId/settings/room-filters";

type BookingRoomFilterSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingRoomFilterSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface GetBookingRoomFilterSettingsInput {
  hotelId: string;
}

export interface BookingRoomFilterSettings {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
}

export type UpdateBookingRoomFilterSettingsBody = BookingRoomFilterSettings;

export interface UpdateBookingRoomFilterSettingsInput {
  hotelId: string;
  body: UpdateBookingRoomFilterSettingsBody;
}

export type BookingRoomFilterSettingsErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "read_model"
>;
export type BookingRoomFilterSettingsWriteErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "validation" | "write_model"
>;
export type BookingRoomFilterSettingsClientErrorCategory = BookingSettingsClientErrorCategory;

export type BookingRoomFilterSettingsErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable"
>;
export type BookingRoomFilterSettingsWriteErrorCode = Extract<
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
export type BookingRoomFilterSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingRoomFilterSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingRoomFilterSettingsClientErrorCode;
  category: BookingRoomFilterSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingRoomFilterSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingRoomFilterSettings(
  input: GetBookingRoomFilterSettingsInput,
  client: BookingRoomFilterSettingsReadApiClient = apiClient,
): Promise<BookingRoomFilterSettings> {
  try {
    return await client.get<BookingRoomFilterSettings>(
      buildBookingRoomFilterSettingsEndpoint(input),
    );
  } catch (error) {
    throw toBookingRoomFilterSettingsClientError(error);
  }
}

export async function updateBookingRoomFilterSettings(
  input: UpdateBookingRoomFilterSettingsInput,
  client: BookingRoomFilterSettingsWriteApiClient = apiClient,
): Promise<BookingRoomFilterSettings> {
  try {
    return await client.put<BookingRoomFilterSettings>(
      buildBookingRoomFilterSettingsEndpoint(input),
      input.body,
    );
  } catch (error) {
    throw toBookingRoomFilterSettingsClientError(error, "write");
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
  operation: BookingSettingsClientOperation = "read",
): BookingRoomFilterSettingsClientError {
  if (error instanceof BookingRoomFilterSettingsClientError) {
    return error;
  }

  return new BookingRoomFilterSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking room-filter settings are unavailable.",
      readNotFound: false,
    }),
  );
}
