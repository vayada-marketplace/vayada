import { describe, expect, it } from "vitest";

import {
  BookingCustomDomainClientError,
  buildBookingCustomDomainEndpoint,
  deleteBookingCustomDomain,
  getBookingCustomDomain,
  upsertBookingCustomDomain,
  type BookingCustomDomainResponse,
} from "./bookingCustomDomainClient";
import { ApiErrorResponse, type ApiClient } from "./client";

type CustomDomainClient = Pick<ApiClient, "get" | "put" | "delete">;

const response: BookingCustomDomainResponse = {
  hotelId: "booking_hotel_alpenrose",
  propertyId: "f6853000-0000-0000-0000-000000000001",
  configured: true,
  domain: "book.alpenrose.example",
  status: "pending",
  sslStatus: "pending",
  dnsRecords: [
    {
      type: "CNAME",
      name: "book.alpenrose.example",
      value: "custom.booking.vayada.com",
      status: "pending",
    },
  ],
  verificationErrors: [],
  checkedAt: "2026-06-22T10:00:00.000Z",
  updatedAt: "2026-06-22T10:00:00.000Z",
};

describe("booking custom-domain client", () => {
  it("builds the typed custom-domain endpoint", () => {
    expect(buildBookingCustomDomainEndpoint({ hotelId: " hotel/with space " })).toBe(
      "/api/booking/hotels/hotel%2Fwith%20space/custom-domain",
    );
  });

  it("sends get, upsert, and delete calls to the target route", async () => {
    const calls: Array<{ method: string; endpoint: string; body?: unknown }> = [];
    const client = createClient({
      get: async <T>(endpoint: string) => {
        calls.push({ method: "GET", endpoint });
        return response as T;
      },
      put: async <T>(endpoint: string, body?: unknown) => {
        calls.push({ method: "PUT", endpoint, body });
        return response as T;
      },
      delete: async <T>(endpoint: string) => {
        calls.push({ method: "DELETE", endpoint });
        return undefined as T;
      },
    });

    await expect(
      getBookingCustomDomain({ hotelId: "booking_hotel_alpenrose" }, client),
    ).resolves.toEqual(response);
    await expect(
      upsertBookingCustomDomain(
        { hotelId: "booking_hotel_alpenrose", domain: "book.alpenrose.example" },
        client,
      ),
    ).resolves.toEqual(response);
    await expect(
      deleteBookingCustomDomain({ hotelId: "booking_hotel_alpenrose" }, client),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      {
        method: "GET",
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      },
      {
        method: "PUT",
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
        body: { domain: "book.alpenrose.example" },
      },
      {
        method: "DELETE",
        endpoint: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      },
    ]);
  });

  it("maps contract errors to the typed client error", async () => {
    const client = createClient({
      put: async () => {
        throw new ApiErrorResponse(422, {
          statusCode: 422,
          code: "invalid_payload",
          category: "validation",
          message: "Booking custom-domain payload is invalid.",
          details: ["domain must be a hostname."],
        } as never);
      },
    });

    const error = await catchError(() =>
      upsertBookingCustomDomain(
        { hotelId: "booking_hotel_alpenrose", domain: "https://example.com/path" },
        client,
      ),
    );

    expect(error).toBeInstanceOf(BookingCustomDomainClientError);
    expect(error).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      detail: "Booking custom-domain payload is invalid.",
      details: ["domain must be a hostname."],
    });
  });

  it("rejects missing hotel ids before issuing a request", () => {
    expect(() => buildBookingCustomDomainEndpoint({ hotelId: " " })).toThrow(
      BookingCustomDomainClientError,
    );
  });
});

function createClient(overrides: Partial<CustomDomainClient>): CustomDomainClient {
  return {
    get: overrides.get ?? fail,
    put: overrides.put ?? fail,
    delete: overrides.delete ?? fail,
  } as CustomDomainClient;
}

async function fail(): Promise<never> {
  throw new Error("unexpected client call");
}

async function catchError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}
