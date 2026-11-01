import { describe, expect, it } from "vitest";
import {
  moveOption,
  setDefault,
  shownOptions,
  toggleOption,
  type RoomSorting,
} from "./roomSorting";

// VAY-2449: the rules of Settings › Room Sorting.
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

describe("Room Sorting rules", () => {
  it("shows or hides an option, and moves the default when it is hidden", () => {
    const withCapacity = toggleOption(sorting, "capacity");
    expect(shownOptions(withCapacity)).toEqual([
      "recommended",
      "priceLow",
      "priceHigh",
      "roomSize",
      "capacity",
    ]);
    const noRecommended = toggleOption(sorting, "recommended");
    expect(shownOptions(noRecommended)).toEqual(["priceLow", "priceHigh", "roomSize"]);
    expect(noRecommended.defaultOption).toBe("priceLow");
    // Hiding another option keeps the default.
    expect(toggleOption(sorting, "roomSize").defaultOption).toBe("recommended");
  });

  it("keeps the last option shown", () => {
    let only = sorting;
    for (const key of ["priceLow", "priceHigh", "roomSize"] as const)
      only = toggleOption(only, key);
    expect(shownOptions(only)).toEqual(["recommended"]);
    expect(toggleOption(only, "recommended")).toBe(only);
  });

  it("takes only a shown option as the default", () => {
    expect(setDefault(sorting, "priceHigh").defaultOption).toBe("priceHigh");
    expect(setDefault(sorting, "bestDeal")).toBe(sorting);
  });

  it("moves an option within the menu", () => {
    expect(shownOptions(moveOption(sorting, "roomSize", 0))).toEqual([
      "roomSize",
      "recommended",
      "priceLow",
      "priceHigh",
    ]);
    expect(moveOption(sorting, "recommended", -1)).toBe(sorting);
    expect(moveOption(sorting, "bestDeal", 6)).toBe(sorting);
    expect(moveOption(sorting, "capacity", 4)).toBe(sorting);
  });
});
