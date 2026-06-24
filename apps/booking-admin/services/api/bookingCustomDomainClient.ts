import { apiClient, omitHotelContext, type ApiClient } from "./client";
import {
  toBookingSettingsClientErrorInput,
  type BookingSettingsClientErrorCategory,
  type BookingSettingsClientErrorCode,
  type BookingSettingsClientErrorInput,
  type BookingSettingsClientErrorStatusCode,
  type BookingSettingsClientOperation,
} from "./bookingSettingsClientError";

export const BOOKING_CUSTOM_DOMAIN_PATH = "/api/booking/hotels/:hotelId/custom-domain";

type BookingCustomDomainReadApiClient = Pick<ApiClient, "get">;
type BookingCustomDomainWriteApiClient = Pick<ApiClient, "put" | "delete">;

export type BookingCustomDomainStatus = "not_configured" | "pending" | "verified" | "failed";
export type BookingCustomDomainSslStatus = "not_configured" | "pending" | "active" | "failed";

export interface BookingCustomDomainDnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  status: "pending" | "verified" | "failed";
}

export interface BookingCustomDomainResponse {
  hotelId: string;
  propertyId: string;
  configured: boolean;
  domain: string | null;
  status: BookingCustomDomainStatus;
  sslStatus: BookingCustomDomainSslStatus;
  dnsRecords: BookingCustomDomainDnsRecord[];
  verificationErrors: string[];
  checkedAt: string | null;
  updatedAt: string | null;
}

export interface BookingCustomDomainInput {
  hotelId: string;
}

export interface UpsertBookingCustomDomainInput extends BookingCustomDomainInput {
  domain: string;
}

export type BookingCustomDomainClientErrorCategory = BookingSettingsClientErrorCategory;
export type BookingCustomDomainClientErrorCode = BookingSettingsClientErrorCode;

export class BookingCustomDomainClientError extends Error {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingCustomDomainClientErrorCode;
  category: BookingCustomDomainClientErrorCategory;
  detail: string;
  details?: unknown;

  constructor(input: BookingSettingsClientErrorInput) {
    super(input.detail);
    this.name = "BookingCustomDomainClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function getBookingCustomDomain(
  input: BookingCustomDomainInput,
  client: BookingCustomDomainReadApiClient = apiClient,
): Promise<BookingCustomDomainResponse> {
  try {
    return await client.get<BookingCustomDomainResponse>(
      buildBookingCustomDomainEndpoint(input),
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingCustomDomainClientError(error);
  }
}

export async function upsertBookingCustomDomain(
  input: UpsertBookingCustomDomainInput,
  client: BookingCustomDomainWriteApiClient = apiClient,
): Promise<BookingCustomDomainResponse> {
  try {
    return await client.put<BookingCustomDomainResponse>(
      buildBookingCustomDomainEndpoint(input),
      { domain: input.domain },
      omitHotelContext,
    );
  } catch (error) {
    throw toBookingCustomDomainClientError(error, "write");
  }
}

export async function deleteBookingCustomDomain(
  input: BookingCustomDomainInput,
  client: BookingCustomDomainWriteApiClient = apiClient,
): Promise<void> {
  try {
    await client.delete<void>(buildBookingCustomDomainEndpoint(input), omitHotelContext);
  } catch (error) {
    throw toBookingCustomDomainClientError(error, "write");
  }
}

export function buildBookingCustomDomainEndpoint(input: BookingCustomDomainInput): string {
  const hotelId = input.hotelId.trim();
  if (!hotelId) {
    throw new BookingCustomDomainClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Booking hotel id is required.",
    });
  }

  return BOOKING_CUSTOM_DOMAIN_PATH.replace(":hotelId", encodeURIComponent(hotelId));
}

export function toBookingCustomDomainClientError(
  error: unknown,
  operation: BookingSettingsClientOperation = "read",
): BookingCustomDomainClientError {
  if (error instanceof BookingCustomDomainClientError) {
    return error;
  }

  return new BookingCustomDomainClientError(
    toBookingSettingsClientErrorInput(error, {
      operation,
      fallbackDetail: "Booking custom-domain settings are unavailable.",
      readNotFound: true,
    }),
  );
}
