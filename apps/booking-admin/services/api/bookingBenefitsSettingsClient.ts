import { apiClient, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_BENEFITS_SETTINGS_PATH = "/api/booking/hotels/:hotelId/settings/benefits";

type BookingBenefitsSettingsReadApiClient = Pick<ApiClient, "get">;
type BookingBenefitsSettingsWriteApiClient = Pick<ApiClient, "put">;

export interface GetBookingBenefitsSettingsInput {
  hotelId: string;
}

export interface BookingBenefitsSettings {
  benefits: string[];
}

export type UpdateBookingBenefitsSettingsBody = BookingBenefitsSettings;

export interface UpdateBookingBenefitsSettingsInput {
  hotelId: string;
  body: UpdateBookingBenefitsSettingsBody;
}

export type BookingBenefitsSettingsErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "read_model"
>;
export type BookingBenefitsSettingsWriteErrorCategory = Extract<
  BookingSettingsClientErrorCategory,
  "authentication" | "authorization" | "validation" | "write_model"
>;
export type BookingBenefitsSettingsClientErrorCategory = BookingSettingsClientErrorCategory;

export type BookingBenefitsSettingsErrorCode = Extract<
  BookingSettingsClientErrorCode,
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable"
>;
export type BookingBenefitsSettingsWriteErrorCode = Extract<
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
export type BookingBenefitsSettingsClientErrorCode = BookingSettingsClientErrorCode;

export class BookingBenefitsSettingsClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingBenefitsSettingsClientErrorCode;
  category: BookingBenefitsSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingBenefitsSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingBenefitsSettings(
  input: GetBookingBenefitsSettingsInput,
  client: BookingBenefitsSettingsReadApiClient = apiClient,
): Promise<BookingBenefitsSettings> {
  try {
    return await client.get<BookingBenefitsSettings>(buildBookingBenefitsSettingsEndpoint(input));
  } catch (error) {
    throw toBookingBenefitsSettingsClientError(error);
  }
}

export async function updateBookingBenefitsSettings(
  input: UpdateBookingBenefitsSettingsInput,
  client: BookingBenefitsSettingsWriteApiClient = apiClient,
): Promise<BookingBenefitsSettings> {
  try {
    return await client.put<BookingBenefitsSettings>(
      buildBookingBenefitsSettingsEndpoint(input),
      input.body,
    );
  } catch (error) {
    throw toBookingBenefitsSettingsClientError(error, "write");
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
  operation: BookingSettingsClientOperation = "read",
): BookingBenefitsSettingsClientError {
  if (error instanceof BookingBenefitsSettingsClientError) {
    return error;
  }

  return new BookingBenefitsSettingsClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking benefits settings are unavailable.",
      readNotFound: false,
    }),
  );
}
