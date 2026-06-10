import { describe, expect, it } from "vitest";

import {
  BookingAddonSettingsClientError,
  updateBookingAddonSettings,
  type BookingAddonSettings,
} from "./bookingAddonSettingsClient";
import {
  BookingBenefitsSettingsClientError,
  updateBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "./bookingBenefitsSettingsClient";
import { ApiErrorResponse, type ApiClient } from "./client";
import {
  BookingGuestFormSettingsClientError,
  updateBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "./bookingGuestFormSettingsClient";
import {
  BookingLocalizationSettingsClientError,
  updateBookingLocalizationSettings,
  type BookingLocalizationSettings,
} from "./bookingLocalizationSettingsClient";
import {
  BookingRoomFilterSettingsClientError,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "./bookingRoomFilterSettingsClient";

type WriteClient = Pick<ApiClient, "put">;

type UpdateCase<TBody> = {
  name: string;
  endpoint: string;
  body: TBody;
  errorClass: new (...args: never[]) => Error;
  missingHotelIdError: {
    statusCode: number;
    code: string;
    category: string;
  };
  update(input: { hotelId: string; body: TBody }, client: WriteClient): Promise<unknown>;
};

const updateCases: Array<UpdateCase<unknown>> = [
  {
    name: "add-ons",
    endpoint: "/api/booking/hotels/hotel%2Fwith%20space/settings/addons",
    body: {
      showAddonsStep: true,
      groupAddonsByCategory: false,
    } satisfies BookingAddonSettings,
    errorClass: BookingAddonSettingsClientError,
    missingHotelIdError: {
      statusCode: 404,
      code: "not_found",
      category: "read_model",
    },
    update: (input, client) =>
      updateBookingAddonSettings(
        {
          ...input,
          body: input.body as BookingAddonSettings,
        },
        client,
      ),
  },
  {
    name: "guest form",
    endpoint: "/api/booking/hotels/hotel%2Fwith%20space/settings/guest-form",
    body: {
      specialRequestsEnabled: true,
      arrivalTimeEnabled: true,
      guestCountEnabled: false,
    } satisfies BookingGuestFormSettings,
    errorClass: BookingGuestFormSettingsClientError,
    missingHotelIdError: {
      statusCode: 404,
      code: "not_found",
      category: "read_model",
    },
    update: (input, client) =>
      updateBookingGuestFormSettings(
        {
          ...input,
          body: input.body as BookingGuestFormSettings,
        },
        client,
      ),
  },
  {
    name: "benefits",
    endpoint: "/api/booking/hotels/hotel%2Fwith%20space/settings/benefits",
    body: {
      benefits: ["Late checkout", "Breakfast"],
    } satisfies BookingBenefitsSettings,
    errorClass: BookingBenefitsSettingsClientError,
    missingHotelIdError: {
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
    },
    update: (input, client) =>
      updateBookingBenefitsSettings(
        {
          ...input,
          body: input.body as BookingBenefitsSettings,
        },
        client,
      ),
  },
  {
    name: "localization",
    endpoint: "/api/booking/hotels/hotel%2Fwith%20space/settings/localization",
    body: {
      defaultCurrency: "CHF",
      defaultLanguage: "de-CH",
      supportedCurrencies: ["EUR"],
      supportedLanguages: ["en"],
    } satisfies BookingLocalizationSettings,
    errorClass: BookingLocalizationSettingsClientError,
    missingHotelIdError: {
      statusCode: 404,
      code: "not_found",
      category: "read_model",
    },
    update: (input, client) =>
      updateBookingLocalizationSettings(
        {
          ...input,
          body: input.body as BookingLocalizationSettings,
        },
        client,
      ),
  },
  {
    name: "room filters",
    endpoint: "/api/booking/hotels/hotel%2Fwith%20space/settings/room-filters",
    body: {
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101"],
        spa_access: ["room_102"],
      },
    } satisfies BookingRoomFilterSettings,
    errorClass: BookingRoomFilterSettingsClientError,
    missingHotelIdError: {
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
    },
    update: (input, client) =>
      updateBookingRoomFilterSettings(
        {
          ...input,
          body: input.body as BookingRoomFilterSettings,
        },
        client,
      ),
  },
];

describe("booking settings write clients", () => {
  it.each(updateCases)("sends the $name write body to the typed endpoint", async (testCase) => {
    const calls: Array<{ endpoint: string; body: unknown }> = [];
    const client = createClient({
      put: async (endpoint, body) => {
        calls.push({ endpoint, body });
        return testCase.body;
      },
    });

    const result = await testCase.update(
      {
        hotelId: " hotel/with space ",
        body: testCase.body,
      },
      client,
    );

    expect(result).toEqual(testCase.body);
    expect(calls).toEqual([
      {
        endpoint: testCase.endpoint,
        body: testCase.body,
      },
    ]);
  });

  it.each(updateCases)(
    "maps $name write contract errors to typed client errors",
    async (testCase) => {
      const details = ["benefits.0 must not be empty."];
      const client = createClient({
        put: async () => {
          throw new ApiErrorResponse(422, {
            statusCode: 422,
            code: "invalid_payload",
            category: "validation",
            message: "Booking settings payload is invalid.",
            details,
          } as never);
        },
      });

      const error = await catchError(() =>
        testCase.update(
          {
            hotelId: "booking_hotel_alpenrose",
            body: testCase.body,
          },
          client,
        ),
      );

      expect(error).toBeInstanceOf(testCase.errorClass);
      expect(error).toMatchObject({
        statusCode: 422,
        code: "invalid_payload",
        category: "validation",
        detail: "Booking settings payload is invalid.",
        details,
      });
    },
  );

  it.each(updateCases)(
    "keeps the $name empty hotel id behavior aligned with reads",
    async (testCase) => {
      const client = createClient({
        put: async () => {
          throw new Error("put should not be called");
        },
      });

      const error = await catchError(() =>
        testCase.update(
          {
            hotelId: "   ",
            body: testCase.body,
          },
          client,
        ),
      );

      expect(error).toBeInstanceOf(testCase.errorClass);
      expect(error).toMatchObject({
        ...testCase.missingHotelIdError,
        detail: "Booking hotel id is required.",
      });
    },
  );

  it.each(updateCases)(
    "maps generic $name write failures to write-model errors",
    async (testCase) => {
      const client = createClient({
        put: async () => {
          throw new Error("network unavailable");
        },
      });

      const error = await catchError(() =>
        testCase.update(
          {
            hotelId: "booking_hotel_alpenrose",
            body: testCase.body,
          },
          client,
        ),
      );

      expect(error).toBeInstanceOf(testCase.errorClass);
      expect(error).toMatchObject({
        statusCode: 500,
        code: "write_model_unavailable",
        category: "write_model",
        detail: "network unavailable",
      });
    },
  );
});

function createClient(input: {
  put(endpoint: string, body?: unknown): Promise<unknown>;
}): WriteClient {
  return {
    put: async <T>(endpoint: string, body?: unknown) => input.put(endpoint, body) as Promise<T>,
  };
}

async function catchError(input: () => Promise<unknown>): Promise<unknown> {
  try {
    await input();
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
