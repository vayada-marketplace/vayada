import { afterEach, describe, expect, it, vi } from "vitest";

import { findAddressOnMap } from "./googleMaps";

function stubPlacesTextSearch(
  places: { location?: { lat: () => number; lng: () => number }; types?: string[] }[],
) {
  const searchByText = vi.fn(async () => ({ places }));
  vi.stubGlobal("window", {
    google: {
      maps: {
        importLibrary: async (library: string) => {
          expect(library).toBe("places");
          return { Place: { searchByText } };
        },
      },
    },
  });
  return searchByText;
}

describe("findAddressOnMap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first text-search result's position and whether it is one building", async () => {
    const searchByText = stubPlacesTextSearch([
      { location: { lat: () => 48.1373932, lng: () => 11.5754485 }, types: ["street_address"] },
    ]);

    await expect(
      findAddressOnMap("test-key", "Marienplatz 1, 80331 Munich, Germany"),
    ).resolves.toEqual({ position: { lat: 48.1373932, lng: 11.5754485 }, precise: true });
    expect(searchByText).toHaveBeenCalledWith({
      textQuery: "Marienplatz 1, 80331 Munich, Germany",
      fields: ["location", "types"],
      maxResultCount: 1,
    });
  });

  it("marks a street, postcode or town match as an area", async () => {
    stubPlacesTextSearch([
      { location: { lat: () => 48.1351, lng: () => 11.582 }, types: ["postal_code"] },
    ]);
    await expect(findAddressOnMap("test-key", "Unknown Street 5, 80331 Munich")).resolves.toEqual({
      position: { lat: 48.1351, lng: 11.582 },
      precise: false,
    });
  });

  it("returns null when Google finds no place or no location", async () => {
    stubPlacesTextSearch([]);
    await expect(findAddressOnMap("test-key", "Unknown Street 5")).resolves.toBeNull();

    stubPlacesTextSearch([{}]);
    await expect(findAddressOnMap("test-key", "Unknown Street 5")).resolves.toBeNull();
  });
});
