import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
} from "./bookingSettingsClientError";

export const BOOKING_HOTEL_PROPERTY_LINK_PATH = "/api/booking/hotels/:hotelId/property-link";

type BookingPropertyLinkApiClient = Pick<ApiClient, "get">;

export interface GetBookingHotelPropertyLinkInput {
  hotelId: string;
}

export interface BookingHotelPropertyLink {
  hotelId: string;
  propertyId: string;
  resourceLinks: {
    bookingHotel: true;
    pmsProperty: boolean;
    financeProperty: boolean;
  };
}

export class BookingPropertyLinkClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingSettingsClientErrorCode;
  category: BookingSettingsClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingPropertyLinkClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingHotelPropertyLink(
  input: GetBookingHotelPropertyLinkInput,
  client: BookingPropertyLinkApiClient = apiClient,
): Promise<BookingHotelPropertyLink> {
  try {
    return await client.get<BookingHotelPropertyLink>(
      buildBookingHotelPropertyLinkEndpoint(input),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingPropertyLinkClientError(error);
  }
}

export function buildBookingHotelPropertyLinkEndpoint(
  input: GetBookingHotelPropertyLinkInput,
): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingPropertyLinkClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_HOTEL_PROPERTY_LINK_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

function toBookingPropertyLinkClientError(error: unknown): BookingPropertyLinkClientError {
  if (error instanceof BookingPropertyLinkClientError) return error;

  return new BookingPropertyLinkClientError(
    toBookingSettingsClientErrorInput(error, {
      operation: "read",
      fallbackDetail: "Booking hotel property link is unavailable.",
      readNotFound: true,
    }),
  );
}
