import { describe, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import type { HotelSummary } from "@/services/settings";
import { isTransientHotelListFailure, resolveHandoffRouting } from "./routeAfterHandoff";

const ADD_PROPERTY = "/setup?entryProduct=pms&returnProduct=pms&returnTo=%2Fdashboard&mode=add";
const alpenrose: HotelSummary = {
  id: "booking_hotel_alpenrose",
  propertyId: "property-1",
  name: "Alpenrose",
  slug: "alpenrose",
  location: "Munich",
  country: "DE",
};
const bergwald: HotelSummary = {
  id: "booking_hotel_bergwald",
  propertyId: "property-2",
  name: "Bergwald",
  slug: "bergwald",
  location: "Garmisch",
  country: "DE",
};

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    snapshot: () => Object.fromEntries(data),
  };
}

describe("isTransientHotelListFailure", () => {
  it.each([
    [new ApiErrorResponse(503, { detail: "down" }), true],
    [new ApiErrorResponse(429, { detail: "slow down" }), true],
    [new TypeError("fetch failed"), true],
    [new ApiErrorResponse(403, { detail: "forbidden" }), false],
    [new ApiErrorResponse(422, { detail: "invalid" }), false],
    [new Error("Hotel setup data is invalid. Refresh the page and try again."), false],
  ])("classifies %s as transient=%s", (error, transient) => {
    expect(isTransientHotelListFailure(error)).toBe(transient);
  });
});

describe("resolveHandoffRouting", () => {
  it("keeps the handoff target and asks for a retry when the hotel list is down", async () => {
    const storage = memoryStorage({ selectedHotelId: "stale" });
    await expect(
      resolveHandoffRouting(
        { safeRedirect: ADD_PROPERTY, propertyId: null, handoffHotelId: null },
        {
          listHotels: vi.fn().mockRejectedValue(new ApiErrorResponse(503, { detail: "down" })),
          storage,
        },
      ),
    ).resolves.toEqual({ kind: "retry" });
    expect(storage.snapshot()).toEqual({ selectedHotelId: "stale" });
  });

  it("keeps the previous setup fallback when the hotel list is rejected for good", async () => {
    const storage = memoryStorage();
    await expect(
      resolveHandoffRouting(
        { safeRedirect: ADD_PROPERTY, propertyId: "property-1", handoffHotelId: null },
        {
          listHotels: vi.fn().mockRejectedValue(new ApiErrorResponse(403, { detail: "forbidden" })),
          storage,
        },
      ),
    ).resolves.toEqual({
      kind: "navigate",
      href: "/setup?entryProduct=booking&propertyId=property-1",
    });
    expect(storage.getItem("setupComplete")).toBe("false");
  });

  it("falls back to setup for the named property when the list fails without a target", async () => {
    const storage = memoryStorage();
    await expect(
      resolveHandoffRouting(
        { safeRedirect: null, propertyId: "property-1", handoffHotelId: null },
        { listHotels: vi.fn().mockRejectedValue(new Error("503")), storage },
      ),
    ).resolves.toEqual({
      kind: "navigate",
      href: "/setup?entryProduct=booking&propertyId=property-1",
    });
    expect(storage.getItem("setupComplete")).toBe("false");
  });

  it("opens the handoff target after selecting the hinted hotel", async () => {
    const storage = memoryStorage();
    await expect(
      resolveHandoffRouting(
        { safeRedirect: ADD_PROPERTY, propertyId: "property-2", handoffHotelId: null },
        { listHotels: vi.fn().mockResolvedValue([alpenrose, bergwald]), storage },
      ),
    ).resolves.toEqual({ kind: "navigate", href: ADD_PROPERTY });
    expect(storage.snapshot()).toEqual({
      selectedSharedPropertyId: "property-2",
      selectedHotelId: "booking_hotel_bergwald",
      setupComplete: "true",
    });
  });

  it("opens the handoff target without a selection when nothing was hinted or stored", async () => {
    const storage = memoryStorage();
    await expect(
      resolveHandoffRouting(
        { safeRedirect: ADD_PROPERTY, propertyId: null, handoffHotelId: null },
        { listHotels: vi.fn().mockResolvedValue([alpenrose, bergwald]), storage },
      ),
    ).resolves.toEqual({ kind: "navigate", href: ADD_PROPERTY });
    expect(storage.getItem("selectedHotelId")).toBeNull();
  });

  it("does not replace an inaccessible explicit property with another hotel", async () => {
    const storage = memoryStorage({ selectedHotelId: "booking_hotel_alpenrose" });
    await expect(
      resolveHandoffRouting(
        { safeRedirect: ADD_PROPERTY, propertyId: "property-9", handoffHotelId: null },
        { listHotels: vi.fn().mockResolvedValue([alpenrose]), storage },
      ),
    ).resolves.toEqual({
      kind: "navigate",
      href: "/setup?entryProduct=booking&propertyId=property-9",
    });
    expect(storage.getItem("selectedHotelId")).toBeNull();
    expect(storage.getItem("setupComplete")).toBe("false");
  });

  it.each([
    [[], "/setup"],
    [[alpenrose], "/dashboard"],
    [[alpenrose, bergwald], "/choose-property"],
  ])("without a target routes %j hotels to %s", async (hotels, href) => {
    const storage = memoryStorage();
    await expect(
      resolveHandoffRouting(
        { safeRedirect: null, propertyId: null, handoffHotelId: null },
        { listHotels: vi.fn().mockResolvedValue(hotels as HotelSummary[]), storage },
      ),
    ).resolves.toEqual({ kind: "navigate", href });
  });
});
