import { describe, expect, it } from "vitest";

import { roomPlace, type GuestPlace } from "./RoomPlace";
import type { PricingRoom } from "@/services/api/replacementOffers";

const property: GuestPlace = {
  name: "Hotel Alpenrose",
  locality: "Munich, Germany",
  pin: { latitude: 48.1394, longitude: 11.5835, approximate: false },
};
const room = (extra: Partial<PricingRoom>): PricingRoom => ({
  roomTypeId: "villa",
  name: "Beach Villa",
  offers: [],
  ...extra,
});

describe("where you'll stay (VAY-2323)", () => {
  it("shows a room's own place with its street, the property for reference and the distance", () => {
    expect(
      roomPlace(
        room({
          atProperty: false,
          location: { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12" },
        }),
        property,
      ),
    ).toEqual({
      name: "Beach Villa",
      address: "Leopoldstraße 12",
      pin: { latitude: 48.15634, longitude: 11.58242 },
      approximate: false,
      reception: { latitude: 48.1394, longitude: 11.5835 },
      distance: expect.closeTo(1885, -1),
    });
  });

  it("shows an area by its name only, and no exact-looking reference for a rounded property", () => {
    const place = roomPlace(
      room({
        atProperty: false,
        location: { latitude: 48.13, longitude: 11.57, approximate: true, area: "Isarvorstadt" },
      }),
      { ...property, pin: { latitude: 48.14, longitude: 11.58, approximate: true } },
    );
    expect(place).toMatchObject({ address: "Isarvorstadt", approximate: true, reception: null });
  });

  it("puts a room at the property on the property's public pin, without a distance", () => {
    expect(roomPlace(room({ atProperty: true }), property)).toEqual({
      name: "Hotel Alpenrose",
      address: "Munich, Germany",
      pin: { latitude: 48.1394, longitude: 11.5835 },
      approximate: false,
      reception: null,
      distance: null,
    });
    // A catalog from before VAY-2321 doesn't say: no pin of its own means at the property.
    expect(roomPlace(room({}), property)?.name).toBe("Hotel Alpenrose");
  });

  it("shows nothing while the map is off, the room's details map is off, or there is no place", () => {
    const villa = room({
      atProperty: false,
      location: { latitude: 48.15634, longitude: 11.58242 },
    });
    expect(roomPlace(villa, null)).toBeNull();
    expect(roomPlace({ ...villa, showMapInDetails: false }, property)).toBeNull();
    expect(roomPlace(room({ atProperty: true }), { ...property, pin: null })).toBeNull();
    // A place of its own without a pin yet.
    expect(roomPlace(room({ atProperty: false }), property)).toBeNull();
  });
});
