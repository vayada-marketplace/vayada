import { describe, expect, it } from "vitest";

import {
  locationMapPins,
  type LocationMapPropertyInput,
  type LocationMapRoomInput,
} from "./locationMap.js";

const property: LocationMapPropertyInput = {
  name: "Alpenrose Apartments",
  address: "Maximilianstraße 3, 80539 Munich",
  pin: { latitude: 48.1394, longitude: 11.5835 },
  mapDisplayMode: "exact",
};
const room = (
  id: string,
  pin: [number, number] | null,
  address: string | null = null,
  extra: Partial<LocationMapRoomInput> = {},
): LocationMapRoomInput => ({
  roomTypeId: id,
  name: `Room ${id}`,
  address,
  pin: pin && { latitude: pin[0], longitude: pin[1] },
  ...extra,
});
const atProperty = (id: string) => room(id, null, null, { atProperty: true });

describe("location map pins (VAY-2126, VAY-2321)", () => {
  it("gives rooms in different places a pin each and lists the rooms left off", () => {
    expect(
      locationMapPins(
        [
          room("a", [48.15634, 11.58242], "Leopoldstraße 12"),
          room("b", [48.1291, 11.5952]),
          // "Separate location" without a pin yet.
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
          approximate: false,
        },
        {
          latitude: 48.1291,
          longitude: 11.5952,
          label: "Room b",
          address: null,
          roomTypeIds: ["b"],
          kind: "rooms",
          approximate: false,
        },
      ],
      unpinnedRooms: [room("c", null)],
      propertyRoomsOffMap: [],
    });
  });

  it("puts rooms at the property on the property's pin, first, next to the rooms elsewhere", () => {
    const { pins } = locationMapPins(
      [atProperty("a"), room("villa", [48.15634, 11.58242], "Leopoldstraße 12"), atProperty("b")],
      property,
    );
    expect(pins).toEqual([
      {
        latitude: 48.1394,
        longitude: 11.5835,
        label: "Alpenrose Apartments",
        address: "Maximilianstraße 3, 80539 Munich",
        roomTypeIds: ["a", "b"],
        kind: "property",
        approximate: false,
      },
      expect.objectContaining({ label: "Room villa", roomTypeIds: ["villa"], kind: "rooms" }),
    ]);
    // A room's own pin a few metres from the property's exact pin is at the property too.
    expect(
      locationMapPins([atProperty("a"), room("b", [48.13941, 11.5835])], property).pins,
    ).toEqual([expect.objectContaining({ roomTypeIds: ["a", "b"], kind: "property" })]);
  });

  it("shares one pin between rooms within 25 metres, however their decimals round", () => {
    // About 1 m apart, on either side of a 5-decimal grid line; then about 40 m apart.
    expect(
      locationMapPins(
        [room("a", [48.156345, 11.58242]), room("b", [48.156354, 11.58242])],
        property,
      ).pins,
    ).toHaveLength(1);
    expect(
      locationMapPins([room("a", [48.15634, 11.58242]), room("b", [48.1567, 11.58242])], property)
        .pins,
    ).toHaveLength(2);
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

  it("shows rooms at the property as its visibility allows, and lists them when it can't", () => {
    expect(locationMapPins([atProperty("a"), atProperty("b")], property)).toEqual({
      pins: [
        {
          latitude: 48.1394,
          longitude: 11.5835,
          label: "Alpenrose Apartments",
          address: "Maximilianstraße 3, 80539 Munich",
          roomTypeIds: ["a", "b"],
          kind: "property",
          approximate: false,
        },
      ],
      unpinnedRooms: [],
      propertyRoomsOffMap: [],
    });
    // "Approximate": the property's area, drawn as an area.
    expect(
      locationMapPins([atProperty("a")], { ...property, mapDisplayMode: "approximate" }).pins,
    ).toEqual([expect.objectContaining({ kind: "property", approximate: true })]);
    const hidden = locationMapPins([atProperty("a"), room("b", [48.1291, 11.5952])], {
      ...property,
      mapDisplayMode: "hidden",
    });
    expect(hidden.pins).toEqual([expect.objectContaining({ roomTypeIds: ["b"] })]);
    expect(hidden.propertyRoomsOffMap).toEqual([atProperty("a")]);
    expect(locationMapPins([atProperty("a")], { ...property, pin: null })).toEqual({
      pins: [],
      unpinnedRooms: [],
      propertyRoomsOffMap: [atProperty("a")],
    });
  });

  it("keeps a room shown as an area apart from exact spots, and marks its pin as an area", () => {
    const area = { approximate: true };
    const { pins } = locationMapPins(
      [
        atProperty("a"),
        // Rounded to the same area as the property's exact pin: still drawn on its own, as an area.
        room("b", [48.14, 11.58], "Altstadt", area),
        room("c", [48.14, 11.58], "Altstadt", area),
        room("d", [48.14, 11.58]),
      ],
      property,
    );
    expect(pins).toEqual([
      expect.objectContaining({ roomTypeIds: ["a"], kind: "property", approximate: false }),
      expect.objectContaining({
        roomTypeIds: ["b", "c"],
        address: "Altstadt",
        kind: "rooms",
        approximate: true,
      }),
      expect.objectContaining({ roomTypeIds: ["d"], approximate: false }),
    ]);
    // A property shown as an area takes no room onto its pin, not even one rounded to the same area.
    expect(
      locationMapPins([atProperty("a"), room("b", [48.14, 11.58], "Altstadt", area)], {
        ...property,
        pin: { latitude: 48.14, longitude: 11.58 },
        mapDisplayMode: "approximate",
      }).pins,
    ).toEqual([
      expect.objectContaining({ roomTypeIds: ["a"], kind: "property", approximate: true }),
      expect.objectContaining({ roomTypeIds: ["b"], kind: "rooms", address: "Altstadt" }),
    ]);
    // Every room in one area: still named after its rooms, not the property.
    expect(
      locationMapPins(
        [room("b", [48.14, 11.58], null, area), room("c", [48.14, 11.58], null, area)],
        property,
      ).pins,
    ).toEqual([expect.objectContaining({ label: "Room b, Room c", kind: "rooms" })]);
    // A property shown as an area takes no exact room onto its pin.
    expect(
      locationMapPins([atProperty("a"), room("b", [48.1394, 11.5835])], {
        ...property,
        mapDisplayMode: "approximate",
      }).pins,
    ).toEqual([
      expect.objectContaining({ roomTypeIds: ["a"], approximate: true }),
      expect.objectContaining({ roomTypeIds: ["b"], approximate: false }),
    ]);
  });
});
