import { describe, expect, it, vi } from "vitest";

import { loadBookingFlowSetting } from "./bookingFlowSettingsLoader";

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
