import { describe, expect, it } from "vitest";
import { stayPlaces, type StayPropertyLocation } from "./stayPlaces.js";

const location: StayPropertyLocation = {
  streetAddress: " 12 Matara Road ",
  area: null,
  postalCode: "80650",
  city: "Ahangama",
  countryCode: "LK",
  latitude: 5.973251,
  longitude: 80.362548,
  arrivalDirections: " ",
};
const beach = { latitude: 6.01, longitude: 80.41 };

describe("stayPlaces", () => {
  it("lists the property with its rooms first, then each place elsewhere once", () => {
    expect(
      stayPlaces(location, [
        { name: "Suite", attributes: { locationSource: "property" } },
        {
          name: "Villa",
          attributes: { locationSource: "custom", ...beach, locationAddress: "Beach Rd 1" },
        },
        {
          name: "Cabin",
          attributes: { locationSource: "custom", ...beach, locationAddress: "Beach Rd 1" },
        },
        {
          name: "Hut",
          attributes: {
            locationSource: "custom",
            latitude: 6.1,
            longitude: 80.5,
            locationPrecision: "approximate",
            locationArea: "Midigama",
          },
        },
        // Nothing saved to place it by.
        { name: "Tent", attributes: { locationSource: "custom" } },
      ]),
    ).toEqual([
      {
        kind: "property",
        rooms: ["Suite"],
        streetAddress: "12 Matara Road",
        area: null,
        postalCode: "80650",
        city: "Ahangama",
        countryCode: "LK",
        pin: { latitude: 5.973251, longitude: 80.362548 },
        arrivalDirections: null,
      },
      {
        kind: "elsewhere",
        rooms: ["Villa", "Cabin"],
        address: "Beach Rd 1",
        pin: beach,
        area: null,
        approximate: false,
      },
      {
        kind: "elsewhere",
        rooms: ["Hut"],
        address: null,
        pin: { latitude: 6.1, longitude: 80.5 },
        area: "Midigama",
        approximate: true,
      },
    ]);
  });

  it("leaves the property out when every booked room is elsewhere, and keeps it without booked rooms", () => {
    const villa = { name: "Villa", attributes: { locationSource: "custom", ...beach } };
    expect(stayPlaces(location, [villa]).map((place) => place.kind)).toEqual(["elsewhere"]);
    expect(stayPlaces(location, []).map((place) => place.kind)).toEqual(["property"]);
  });

  it("places nothing for a property without an address or pin", () => {
    const empty = { ...location, streetAddress: null, city: null, latitude: null, longitude: null };
    expect(stayPlaces(empty, [{ name: "Suite", attributes: null }])).toEqual([]);
    expect(stayPlaces(null, [])).toEqual([]);
  });
});
