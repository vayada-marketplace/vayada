import { describe, expect, it, vi } from "vitest";
import type { RoomSorting } from "@/lib/utils/roomSorting";
import { createBookingRoomSortingClient, parseRoomSorting } from "./bookingRoomSortingClient";

// VAY-2449: Settings › Room Sorting's client for next-api.
const propertyId = "F6853000-0000-4000-8000-000000000001";
const sorting: RoomSorting = {
  enabled: true,
  hideWithOneRoom: true,
  options: [
    { key: "recommended", enabled: true },
    { key: "priceLow", enabled: true },
    { key: "priceHigh", enabled: true },
    { key: "roomSize", enabled: true },
    { key: "capacity", enabled: false },
    { key: "bestDeal", enabled: false },
  ],
  defaultOption: "recommended",
};

describe("Room Sorting client", () => {
  it("loads and saves the hotel's Room Sorting on its property", async () => {
    const http = {
      get: vi.fn(async () => ({ sorting, defaults: sorting, canSave: true })),
      put: vi.fn(async (_path: string, body: unknown) => ({ sorting: body })),
    };
    const client = createBookingRoomSortingClient(http as never);
    expect(await client.load(propertyId)).toEqual({ sorting, defaults: sorting, canSave: true });
    expect(http.get).toHaveBeenCalledWith(
      "/api/booking/properties/f6853000-0000-4000-8000-000000000001/room-sorting",
      { signal: undefined, cache: "no-store" },
    );
    const own = { ...sorting, defaultOption: "priceLow" as const };
    expect(await client.save(propertyId, own)).toEqual(own);
    expect(http.put).toHaveBeenCalledWith(
      "/api/booking/properties/f6853000-0000-4000-8000-000000000001/room-sorting",
      own,
    );
  });

  it("refuses an answer it can't read, and a property id that isn't one", async () => {
    const http = {
      get: vi.fn(async () => ({ sorting, canSave: true })),
      put: vi.fn(async () => ({})),
    };
    const client = createBookingRoomSortingClient(http as never);
    await expect(client.load(propertyId)).rejects.toThrow("could not be loaded");
    await expect(client.save(propertyId, sorting)).rejects.toThrow("could not be confirmed");
    await expect(client.load("hotel-1")).rejects.toThrow("valid property");
    for (const invalid of [
      { ...sorting, options: sorting.options.slice(1) },
      { ...sorting, defaultOption: "capacity" },
      { ...sorting, enabled: "yes" },
    ])
      expect(parseRoomSorting(invalid)).toBeNull();
  });
});
