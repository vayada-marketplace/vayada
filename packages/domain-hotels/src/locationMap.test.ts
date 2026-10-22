import { describe, expect, it } from "vitest";

import { locationMapPins, type LocationMapPropertyInput } from "./locationMap.js";

const property: LocationMapPropertyInput = {
  name: "Alpenrose Apartments",
  address: "Maximilianstraße 3, 80539 Munich",
  pin: { latitude: 48.1394, longitude: 11.5835 },
  mapDisplayMode: "exact",
};
const room = (id: string, pin: [number, number] | null, address: string | null = null) => ({
  roomTypeId: id,
  name: `Room ${id}`,
  address,
  pin: pin && { latitude: pin[0], longitude: pin[1] },
});

describe("location map pins (VAY-2126)", () => {
  it("gives rooms in different places a pin each and lists the rooms left off", () => {
    expect(
      locationMapPins(
        [
          room("a", [48.15634, 11.58242], "Leopoldstraße 12"),
          room("b", [48.1291, 11.5952]),
          room("c", null),
        ],
        property,
      ),
    ).toEqual({
      pins: [
        {
          latitude: 48.15634,
          longitude: 11.58242,
          label: "Room a",
          address: "Leopoldstraße 12",
          roomTypeIds: ["a"],
          kind: "rooms",
        },
        {
          latitude: 48.1291,
          longitude: 11.5952,
          label: "Room b",
          address: null,
          roomTypeIds: ["b"],
          kind: "rooms",
        },
      ],
      unpinnedRooms: [room("c", null)],
    });
  });

  it("shares one pin between rooms at the same spot, named after the property when every room is there", () => {
    const together = locationMapPins(
      [room("a", [48.15634, 11.58242]), room("b", [48.156341, 11.582421])],
      property,
    );
    expect(together.pins).toEqual([
      expect.objectContaining({
        label: "Alpenrose Apartments",
        roomTypeIds: ["a", "b"],
        kind: "property",
      }),
    ]);
    // With a room elsewhere (here: no pin), the shared pin keeps its rooms' names.
    const partly = locationMapPins(
      [room("a", [48.15634, 11.58242]), room("b", [48.15634, 11.58242]), room("c", null)],
      property,
    );
    expect(partly.pins).toEqual([
      expect.objectContaining({ label: "Room a, Room b", kind: "rooms" }),
    ]);
  });

  it("falls back to the property's pin when no room has one, unless its visibility is hidden", () => {
    expect(locationMapPins([room("a", null), room("b", null)], property)).toEqual({
      pins: [
        {
          latitude: 48.1394,
          longitude: 11.5835,
          label: "Alpenrose Apartments",
          address: "Maximilianstraße 3, 80539 Munich",
          roomTypeIds: ["a", "b"],
          kind: "property",
        },
      ],
      unpinnedRooms: [],
    });
    expect(
      locationMapPins([room("a", null)], { ...property, mapDisplayMode: "hidden" }).pins,
    ).toEqual([]);
    expect(locationMapPins([room("a", null)], { ...property, pin: null }).pins).toEqual([]);
  });
});
