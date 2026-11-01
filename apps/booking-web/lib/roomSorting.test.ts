import { describe, expect, it } from "vitest";
import {
  catalogRoomSorting,
  DEFAULT_ROOM_SORTING,
  sortMenu,
  type RoomSorting,
} from "./roomSorting";

// VAY-2449: the hotel's Room Sorting on the booking page.
const custom: RoomSorting = {
  enabled: true,
  hideWithOneRoom: true,
  options: ["priceLow", "recommended", "capacity"],
  defaultOption: "capacity",
};

describe("catalogRoomSorting", () => {
  it("reads the catalogue's Room Sorting", () => {
    expect(catalogRoomSorting(custom)).toEqual(custom);
    expect(catalogRoomSorting({ ...custom, enabled: false })).toEqual({
      ...custom,
      enabled: false,
    });
  });

  it("takes the defaults (null) for one that doesn't read", () => {
    for (const raw of [
      undefined,
      null,
      "on",
      { ...custom, enabled: "yes" },
      { ...custom, hideWithOneRoom: undefined },
      { ...custom, options: [] },
      { ...custom, options: ["priceLow", "priceLow"] },
      { ...custom, options: [...custom.options, "cheapest"] },
      { ...custom, defaultOption: "roomSize" },
    ])
      expect(catalogRoomSorting(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe("sortMenu", () => {
  it("shows the hotel's options in its order, its default first chosen, the guest's pick after", () => {
    expect(sortMenu(custom, 3, null)).toEqual({
      order: "capacity",
      options: ["priceLow", "recommended", "capacity"],
    });
    expect(sortMenu(custom, 3, "priceLow").order).toBe("priceLow");
    // A pick the hotel no longer offers falls back to its default.
    expect(sortMenu(custom, 3, "roomSize").order).toBe("capacity");
  });

  it("keeps today's menu by default, without it for a single room", () => {
    expect(sortMenu(DEFAULT_ROOM_SORTING, 2, null)).toEqual({
      order: "recommended",
      options: ["recommended", "priceLow", "priceHigh", "roomSize"],
    });
    expect(sortMenu(DEFAULT_ROOM_SORTING, 1, null)).toEqual({ order: "recommended", options: [] });
    expect(sortMenu({ ...custom, hideWithOneRoom: false }, 1, null).options).toHaveLength(3);
  });

  it("hides the menu with fewer than two options, sorted by the one left", () => {
    expect(
      sortMenu({ ...custom, options: ["priceHigh"], defaultOption: "priceHigh" }, 4, null),
    ).toEqual({
      order: "priceHigh",
      options: [],
    });
  });

  it("shows the hotel's own order and no menu while sorting is off", () => {
    expect(sortMenu({ ...custom, enabled: false }, 4, "priceLow")).toEqual({
      order: "recommended",
      options: [],
    });
  });
});
