import { describe, expect, it } from "vitest";
import type { NearbyCustomPlace } from "@vayada/domain-hotels";
import {
  deleteNearbyCategory,
  distanceKm,
  formatDistance,
  moveItem,
  nearbyCategoryName,
  nearbyPlace,
  tipTooLong,
} from "./nearbyPlaces";
import { englishNearbyPlaces } from "./nearbyPlacesMessages";

const place = (id: string, category: string): NearbyCustomPlace => ({
  id,
  category,
  name: id,
  address: null,
  latitude: 48.1,
  longitude: 11.5,
  favorite: false,
  hidden: false,
  note: null,
});
const music = "c0000000-0000-4000-8000-000000000001";

describe("nearby places editor rules (VAY-2326)", () => {
  it("measures straight-line kilometres and writes them in the reader's language", () => {
    const marienplatz = { latitude: 48.137154, longitude: 11.576124 };
    const chinesischerTurm = { latitude: 48.152468, longitude: 11.592201 };
    expect(distanceKm(marienplatz, chinesischerTurm)).toBeCloseTo(2.05, 1);
    expect(distanceKm(marienplatz, marienplatz)).toBe(0);
    expect(formatDistance(marienplatz, chinesischerTurm, "en", englishNearbyPlaces)).toBe(
      "2.1\u00A0km",
    );
    expect(formatDistance(marienplatz, chinesischerTurm, "de", englishNearbyPlaces)).toBe(
      "2,1\u00A0km",
    );
    expect(formatDistance(marienplatz, marienplatz, "en", englishNearbyPlaces)).toBe("0.0\u00A0km");
  });

  it("moves one place, and leaves the list alone for a move off either end", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });

  it("deletes a host's category, moving its places or removing them", () => {
    const curation = {
      customCategories: [
        { id: music, name: "Live music", color: "pink" as const, icon: "musical-note" as const },
      ],
      customPlaces: [place("jazz", music), place("market", "food"), place("club", music)],
    };
    expect(deleteNearbyCategory(curation, music, "activities")).toEqual({
      customCategories: [],
      customPlaces: [
        place("jazz", "activities"),
        place("market", "food"),
        place("club", "activities"),
      ],
    });
    expect(deleteNearbyCategory(curation, music, null)).toEqual({
      customCategories: [],
      customPlaces: [place("market", "food")],
    });
  });

  it("takes tips up to 140 characters, and a longer one only as it was saved", () => {
    expect(tipTooLong("x".repeat(140), null)).toBe(false);
    expect(tipTooLong(` ${"x".repeat(140)} `, null)).toBe(false);
    expect(tipTooLong("x".repeat(141), null)).toBe(true);
    expect(tipTooLong("y".repeat(300), "y".repeat(300))).toBe(false);
    expect(tipTooLong("y".repeat(299), "y".repeat(300))).toBe(true);
  });

  it("names a category by the host's own name, else its standard name", () => {
    const food = { id: "food", name: null, color: "orange" as const, icon: "cake" as const };
    expect(nearbyCategoryName(food, englishNearbyPlaces)).toBe("Food & drink");
    expect(nearbyCategoryName({ ...food, name: "Street food" }, englishNearbyPlaces)).toBe(
      "Street food",
    );
  });

  it("keeps what the form doesn't edit when it saves a place", () => {
    const saved = { ...place("old", "food"), address: "Viktualienmarkt 3" };
    expect(
      nearbyPlace(
        "old",
        {
          name: " Viktualienmarkt ",
          category: music,
          note: "  ",
          latitude: 48.135,
          longitude: 11.576,
        },
        saved,
      ),
    ).toEqual({
      ...saved,
      name: "Viktualienmarkt",
      category: music,
      note: null,
      latitude: 48.135,
      longitude: 11.576,
    });
  });
});
