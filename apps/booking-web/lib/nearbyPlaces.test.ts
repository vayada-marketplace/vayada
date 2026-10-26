/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  directionsUrl,
  hiddenNearbyCategories,
  hideNearbyCategories,
  parseGuestNearby,
} from "./nearbyPlaces";

const MUSIC = "c0000000-0000-4000-8000-000000000001";
const categories = [
  { id: "food", name: null, color: "orange", icon: "cake" },
  { id: "nature", name: null, color: "teal", icon: "sun" },
  { id: "activities", name: "Must-sees", color: "purple", icon: "camera" },
  { id: "transport", name: null, color: "slate", icon: "map" },
  { id: MUSIC, name: "Live music", color: "pink", icon: "musical-note" },
];
const place = (id: string, category: string, note: string | null = null) => ({
  source: "custom",
  id,
  name: `Place ${id}`,
  address: null,
  category,
  latitude: 48.14,
  longitude: 11.58,
  favorite: false,
  note,
});
const ready = (places: unknown[]) => ({
  schemaVersion: 1,
  status: "ready",
  location: { mode: "exact", latitude: 48.1394, longitude: 11.5835 },
  places,
  categories,
});

describe("the host's nearby places on the guest map (VAY-2327)", () => {
  it("keeps the host's own places in the host's order, with the categories they use", () => {
    const nearby = parseGuestNearby(
      ready([
        place("jazz", MUSIC, "Free jam on Sundays."),
        place("market", "food", "  "),
        place("garden", "activities"),
      ]),
    );
    expect(nearby.places.map(({ id, category, note }) => [id, category.id, note])).toEqual([
      ["jazz", MUSIC, "Free jam on Sundays."],
      ["market", "food", null],
      ["garden", "activities", null],
    ]);
    // The chips: the categories in use, in the host's order (standard ones first), renamed ones as named.
    expect(nearby.categories.map(({ id, name }) => [id, name])).toEqual([
      ["food", null],
      ["activities", "Must-sees"],
      [MUSIC, "Live music"],
    ]);
  });

  it("shows nothing unless the response is ready, and leaves out what it can't place", () => {
    for (const status of ["hidden", "empty", "location_required", "unavailable"])
      expect(parseGuestNearby({ ...ready([place("a", "food")]), status }).places).toEqual([]);
    expect(parseGuestNearby(null).places).toEqual([]);
    expect(parseGuestNearby({ ...ready([place("a", "food")]), schemaVersion: 2 }).places).toEqual(
      [],
    );
    const nearby = parseGuestNearby(
      ready([
        { ...place("google", "food"), source: "google", placeId: "abc" },
        place("unknown-category", "c0000000-0000-4000-8000-000000000009"),
        { ...place("far", "food"), latitude: 91 },
        { ...place("nameless", "food"), name: "  " },
        place("kept", "transport"),
      ]),
    );
    expect(nearby.places.map(({ id }) => id)).toEqual(["kept"]);
    expect(nearby.categories.map(({ id }) => id)).toEqual(["transport"]);
    // A category with a colour or icon the page doesn't know is left out, with its places.
    expect(
      parseGuestNearby({
        ...ready([place("a", "food")]),
        categories: [{ id: "food", name: null, color: "chartreuse", icon: "cake" }],
      }).places,
    ).toEqual([]);
  });

  it("remembers the categories turned off for this tab, and survives blocked storage", () => {
    expect(hiddenNearbyCategories()).toEqual([]);
    hideNearbyCategories(["food", MUSIC]);
    expect(hiddenNearbyCategories()).toEqual(["food", MUSIC]);
    sessionStorage.setItem("vayada.booking.nearbyOff", "not json");
    expect(hiddenNearbyCategories()).toEqual([]);
  });

  it("gives directions to the spot the host placed", () => {
    expect(directionsUrl({ latitude: 48.1525, longitude: 11.5922 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.1525,11.5922",
    );
  });
});

afterEach(() => sessionStorage.clear());
