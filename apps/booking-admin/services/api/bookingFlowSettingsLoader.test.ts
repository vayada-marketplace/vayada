import { describe, expect, it, vi } from "vitest";

import {
  loadBookingFlowSetting,
  normalizeBookingBenefitsSettings,
  normalizeBookingRoomFilterSettings,
} from "./bookingFlowSettingsLoader";
import type { BookingBenefitsSettings } from "./bookingBenefitsSettingsClient";
import type { BookingRoomFilterSettings } from "./bookingRoomFilterSettingsClient";

const DEFAULT_BENEFITS_SETTINGS: BookingBenefitsSettings = {
  benefits: [],
};

const DEFAULT_ROOM_FILTER_SETTINGS: BookingRoomFilterSettings = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

describe("loadBookingFlowSetting", () => {
  it("loads settings for the selected hotel without waiting for property fallback", async () => {
    const read = vi.fn(async (hotelId: string) => ({ hotelId, source: "selected" }));

    await expect(
      loadBookingFlowSetting({
        selectedHotelId: "selected_hotel",
        propertyPromise: new Promise<never>(() => {}),
        read,
        defaultValue: { hotelId: "default", source: "default" },
      }),
    ).resolves.toEqual({ hotelId: "selected_hotel", source: "selected" });

    expect(read).toHaveBeenCalledWith("selected_hotel");
  });

  it("falls back to the property id when no selected hotel exists", async () => {
    const read = vi.fn(async (hotelId: string) => ({ hotelId, source: "property" }));

    await expect(
      loadBookingFlowSetting({
        selectedHotelId: null,
        propertyPromise: Promise.resolve({ id: "property_hotel" }),
        read,
        defaultValue: { hotelId: "default", source: "default" },
      }),
    ).resolves.toEqual({ hotelId: "property_hotel", source: "property" });

    expect(read).toHaveBeenCalledWith("property_hotel");
  });

  it("returns the default settings when no hotel id can be resolved", async () => {
    const defaultValue = { hotelId: "default", source: "default" };
    const read = vi.fn(async () => ({ hotelId: "unexpected", source: "read" }));

    await expect(
      loadBookingFlowSetting({
        selectedHotelId: null,
        propertyPromise: Promise.resolve({ id: null }),
        read,
        defaultValue,
      }),
    ).resolves.toBe(defaultValue);

    expect(read).not.toHaveBeenCalled();
  });

  it("returns the default settings when the property fallback is unavailable", async () => {
    const defaultValue = { hotelId: "default", source: "default" };
    const read = vi.fn(async () => ({ hotelId: "unexpected", source: "read" }));

    await expect(
      loadBookingFlowSetting({
        selectedHotelId: null,
        propertyPromise: Promise.reject(new Error("property unavailable")),
        read,
        defaultValue,
      }),
    ).resolves.toBe(defaultValue);

    expect(read).not.toHaveBeenCalled();
  });

  it("returns the default settings when the typed settings read fails", async () => {
    const defaultValue = { hotelId: "default", source: "default" };

    await expect(
      loadBookingFlowSetting({
        selectedHotelId: "selected_hotel",
        propertyPromise: Promise.resolve({ id: "property_hotel" }),
        read: async () => {
          throw new Error("settings unavailable");
        },
        defaultValue,
      }),
    ).resolves.toBe(defaultValue);
  });
});

describe("normalizeBookingBenefitsSettings", () => {
  it.each([null, undefined, "not a response", [], {}, { benefits: "not an array" }])(
    "returns defaults for malformed benefits settings %#",
    (settings) => {
      expect(normalizeBookingBenefitsSettings(settings, DEFAULT_BENEFITS_SETTINGS)).toBe(
        DEFAULT_BENEFITS_SETTINGS,
      );
    },
  );

  it("keeps only string benefits", () => {
    expect(
      normalizeBookingBenefitsSettings(
        {
          benefits: ["Breakfast", null, "Late checkout", 42, { label: "Spa" }],
        },
        DEFAULT_BENEFITS_SETTINGS,
      ),
    ).toEqual({
      benefits: ["Breakfast", "Late checkout"],
    });
  });
});

describe("normalizeBookingRoomFilterSettings", () => {
  it.each([null, undefined, "not a response", []])(
    "returns defaults for non-record room filter settings %#",
    (settings) => {
      expect(normalizeBookingRoomFilterSettings(settings, DEFAULT_ROOM_FILTER_SETTINGS)).toBe(
        DEFAULT_ROOM_FILTER_SETTINGS,
      );
    },
  );

  it("defaults malformed optional room filter fields to empty structures", () => {
    expect(
      normalizeBookingRoomFilterSettings(
        {
          bookingFilters: "not an array",
          customFilters: ["not a record"],
          filterRooms: "not a record",
        },
        DEFAULT_ROOM_FILTER_SETTINGS,
      ),
    ).toEqual(DEFAULT_ROOM_FILTER_SETTINGS);
  });

  it("normalizes an empty room filter response to empty structures", () => {
    expect(normalizeBookingRoomFilterSettings({}, DEFAULT_ROOM_FILTER_SETTINGS)).toEqual(
      DEFAULT_ROOM_FILTER_SETTINGS,
    );
  });

  it("keeps only string filter keys, labels, and room ids", () => {
    expect(
      normalizeBookingRoomFilterSettings(
        {
          bookingFilters: ["oceanView", 123, "spa_access", null],
          customFilters: {
            oceanView: "Ocean view",
            spa_access: "Spa access",
            invalid: 42,
          },
          filterRooms: {
            oceanView: ["room_101", 101, "room_102", null],
            spa_access: ["room_201"],
            invalid: "not an array",
          },
        },
        DEFAULT_ROOM_FILTER_SETTINGS,
      ),
    ).toEqual({
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        oceanView: "Ocean view",
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        spa_access: ["room_201"],
      },
    });
  });

  it("keeps array-valued filter room entries even when all room ids are malformed", () => {
    expect(
      normalizeBookingRoomFilterSettings(
        {
          filterRooms: {
            emptyAfterFiltering: [1, null, false],
          },
        },
        DEFAULT_ROOM_FILTER_SETTINGS,
      ),
    ).toEqual({
      bookingFilters: [],
      customFilters: {},
      filterRooms: {
        emptyAfterFiltering: [],
      },
    });
  });
});
