import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  observeChannexAvailabilityDate,
  verifyChannexRoomAvailability,
} from "./channexAvailabilityReadback.js";

function fixture(count: unknown = 2) {
  const propertyId = randomUUID(),
    roomTypeId = randomUUID(),
    date = "2030-06-14",
    request = {
      values: [
        {
          property_id: propertyId,
          room_type_id: roomTypeId,
          date_from: date,
          date_to: date,
          availability: 2,
        },
      ],
    },
    get = vi.fn(async (_method: "GET", _path: string) => ({
      data: { [roomTypeId]: { [date]: count } },
      meta: { warnings: [] },
    }));
  return { propertyId, roomTypeId, date, request, get };
}

describe("Channex room availability readback", () => {
  it.each([2, "2"])("accepts an exact numeric %s observation", async (count) => {
    const f = fixture(count);
    await expect(verifyChannexRoomAvailability(f.request, f.get)).resolves.toEqual({
      kind: "availability_observed",
      externalPropertyId: f.propertyId,
      externalRoomTypeId: f.roomTypeId,
      date: f.date,
      availableCount: 2,
    });
    const [method, path] = f.get.mock.calls[0];
    expect(method).toBe("GET");
    const url = new URL(path, "https://staging.channex.io");
    expect(url.pathname).toBe("/api/v1/availability");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "filter[property_id]": f.propertyId,
      "filter[date][gte]": f.date,
      "filter[date][lte]": f.date,
    });
  });

  it("accepts exact sold-out zero", async () => {
    const f = fixture(0);
    f.request.values[0].availability = 0;
    await expect(verifyChannexRoomAvailability(f.request, f.get)).resolves.toMatchObject({
      kind: "availability_observed",
      availableCount: 0,
    });
  });

  it.each([
    [0, 0],
    [3, 3],
    [-1, null],
    [2.1, null],
    [true, null],
    [null, null],
    ["02", null],
    ["2.0", null],
    ["two", null],
  ])(
    "rejects mismatched or malformed value %s, naming the count Channex showed",
    async (count, observedCount) => {
      const f = fixture(count);
      await expect(verifyChannexRoomAvailability(f.request, f.get)).rejects.toMatchObject({
        message: "availability_readback_mismatch",
        observedCount,
      });
    },
  );

  // VAY-2108: what Channex shows for every room on one night, for its cut-off check.
  it("reads every room's count for one night", async () => {
    const propertyId = randomUUID(),
      rooms = [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      date = "2026-11-18";
    const get = vi.fn(async (_method: "GET", _path: string) => ({
      data: {
        [rooms[0]!]: { [date]: 0 },
        [rooms[1]!]: { [date]: "2" },
        [rooms[2]!]: { [date]: null },
      },
      meta: { warnings: [] },
    }));
    const count = await observeChannexAvailabilityDate(propertyId, date, get);
    expect(rooms.map(count)).toEqual([0, 2, null, null]);
    const url = new URL(get.mock.calls[0]![1], "https://staging.channex.io");
    expect(url.pathname).toBe("/api/v1/availability");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "filter[property_id]": propertyId,
      "filter[date][gte]": date,
      "filter[date][lte]": date,
    });
    for (const response of [{}, { errors: {} }, { data: {}, meta: { warnings: ["unsafe"] } }]) {
      get.mockResolvedValueOnce(response as never);
      await expect(observeChannexAvailabilityDate(propertyId, date, get)).rejects.toThrow(
        "availability_readback_unavailable",
      );
    }
    get.mockClear();
    await expect(observeChannexAvailabilityDate("other", date, get)).rejects.toThrow(
      "availability_request_unavailable",
    );
    await expect(observeChannexAvailabilityDate(propertyId, "2026-02-30", get)).rejects.toThrow(
      "availability_request_unavailable",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { values: [] },
    { values: [{ property_id: randomUUID() }, { property_id: randomUUID() }] },
    { values: [{ ...fixture().request.values[0], property_id: "caller-property" }] },
    { values: [{ ...fixture().request.values[0], room_type_id: "caller-room" }] },
    { values: [{ ...fixture().request.values[0], date_to: "2030-06-15" }] },
    {
      values: [{ ...fixture().request.values[0], date_from: "2030-02-30", date_to: "2030-02-30" }],
    },
    { values: [{ ...fixture().request.values[0], availability: "2" }] },
    { extra: true, values: fixture().request.values },
    { values: [{ ...fixture().request.values[0], stop_sell: true }] },
    { values: [{ ...fixture().request.values[0], rate: 100 }] },
    { values: [{ ...fixture().request.values[0], days: 1 }] },
  ])("rejects an invalid persisted request %#", async (request) => {
    const f = fixture();
    await expect(verifyChannexRoomAvailability(request, f.get)).rejects.toThrow(
      "availability_request_unavailable",
    );
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { errors: {} },
    { warnings: [] },
    { data: null },
    { data: {}, meta: { warnings: [] } },
    { data: { [randomUUID()]: {} }, meta: { warnings: [] } },
    { data: {}, meta: { warnings: ["unsafe"] } },
  ])("rejects unavailable provider evidence %#", async (response) => {
    const f = fixture();
    f.get.mockResolvedValue(response as never);
    await expect(verifyChannexRoomAvailability(f.request, f.get)).rejects.toThrow();
  });
});
