import { afterEach, describe, expect, it, vi } from "vitest";

import { addressFromPin } from "./addressFromPin";

const part = (long_name: string, types: string[], short_name = long_name) => ({
  long_name,
  short_name,
  types,
});

function stubGeocoder(geocode: (request: unknown) => Promise<unknown>) {
  vi.stubGlobal("window", {
    google: {
      maps: {
        importLibrary: async (library: string) => {
          if (library !== "geocoding") throw new Error(`unexpected ${library}`);
          return {
            Geocoder: class {
              geocode = geocode;
            },
          };
        },
      },
    },
  });
}

describe("addressFromPin (VAY-2444)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills the address from the most precise result and keeps the pin", async () => {
    const geocode = vi.fn(async () => ({
      results: [
        { types: ["locality", "political"], address_components: [part("Dikwella", ["locality"])] },
        {
          types: ["route"],
          address_components: [
            part("4th Lane", ["route"]),
            part("Hiriketiya", ["sublocality_level_1", "sublocality"]),
            part("Dikwella", ["locality", "political"]),
            part("81200", ["postal_code"]),
            part("Sri Lanka", ["country", "political"], "LK"),
          ],
        },
      ],
    }));
    stubGeocoder(geocode);
    expect(await addressFromPin("key", { lat: 5.9762, lng: 80.7063 })).toEqual({
      streetAddress: "4th Lane",
      postalCode: "81200",
      city: "Dikwella",
      countryCode: "LK",
      region: "",
      latitude: 5.9762,
      longitude: 80.7063,
      location: { latitude: 5.9762, longitude: 80.7063 },
    });
    expect(geocode).toHaveBeenCalledWith({ location: { lat: 5.9762, lng: 80.7063 } });
  });

  it("writes the street the way Google writes it for the country", async () => {
    stubGeocoder(async () => ({
      results: [
        {
          types: ["street_address"],
          formatted_address: "45 Galle Rd, Colombo 00300, Sri Lanka",
          address_components: [
            part("45", ["street_number"]),
            part("Galle Road", ["route"], "Galle Rd"),
            part("Colombo", ["locality", "political"]),
            part("00300", ["postal_code"]),
            part("Sri Lanka", ["country", "political"], "LK"),
          ],
        },
      ],
    }));
    expect((await addressFromPin("key", { lat: 6.9, lng: 79.85 }))?.streetAddress).toBe(
      "45 Galle Rd",
    );
    // A plus code as the first part isn't a street: the parts are used instead.
    stubGeocoder(async () => ({
      results: [
        {
          types: ["plus_code"],
          formatted_address: "XQ8M+GG Dikwella, Sri Lanka",
          address_components: [
            part("XQ8M+GG", ["plus_code"]),
            part("Dikwella", ["locality", "political"]),
            part("Sri Lanka", ["country", "political"], "LK"),
          ],
        },
      ],
    }));
    expect(await addressFromPin("key", { lat: 5.97, lng: 80.7 })).toMatchObject({
      streetAddress: "",
      city: "Dikwella",
      countryCode: "LK",
    });
  });

  it("returns null when Google has no address or refuses the request", async () => {
    stubGeocoder(async () => ({ results: [] }));
    expect(await addressFromPin("key", { lat: 0, lng: 0 })).toBeNull();
    stubGeocoder(async () => {
      throw new Error("REQUEST_DENIED");
    });
    expect(await addressFromPin("key", { lat: 0, lng: 0 })).toBeNull();
  });
});
