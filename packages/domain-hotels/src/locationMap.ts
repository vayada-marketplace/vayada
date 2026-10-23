/** The booking page's location map (VAY-2126): which pins guests see, for Booking Admin's summary and the guest
 * map alike. Rooms at their own address get their own pin; rooms at one spot share a pin; with no room pins,
 * the property's own pin, as its "Guest map visibility" allows. */

export type LocationMapPoint = { latitude: number; longitude: number };
export type LocationMapDisplayMode = "hidden" | "approximate" | "exact";

export type LocationMapRoomInput = {
  roomTypeId: string;
  name: string;
  address?: string | null;
  pin: LocationMapPoint | null;
};

export type LocationMapPropertyInput = {
  name: string;
  address?: string | null;
  pin: LocationMapPoint | null;
  mapDisplayMode: LocationMapDisplayMode;
};

export type LocationMapPin = LocationMapPoint & {
  /** The property's name when the pin stands for every room, otherwise its rooms' names. */
  label: string;
  address: string | null;
  roomTypeIds: string[];
  kind: "rooms" | "property";
  /** The property's pin rounded to its area ("Approximate"): drawn as an area, not an exact spot. */
  approximate: boolean;
};

export type LocationMapPins = {
  pins: LocationMapPin[];
  /** Rooms without a pin of their own while other rooms have one: they're left off the map. */
  unpinnedRooms: LocationMapRoomInput[];
};

// Rooms closer than this share one pin: the same building, typed or dragged a few metres apart.
const SAME_PLACE_METRES = 25;

function metresBetween(a: LocationMapPoint, b: LocationMapPoint): number {
  const toRadians = Math.PI / 180;
  const x =
    (b.longitude - a.longitude) * toRadians * Math.cos(((a.latitude + b.latitude) / 2) * toRadians);
  const y = (b.latitude - a.latitude) * toRadians;
  return Math.hypot(x, y) * 6_371_000;
}

export function locationMapPins(
  rooms: readonly LocationMapRoomInput[],
  property: LocationMapPropertyInput,
): LocationMapPins {
  const pinned = rooms.filter((room) => room.pin);
  if (pinned.length === 0) {
    return {
      pins:
        property.pin && property.mapDisplayMode !== "hidden"
          ? [
              {
                ...property.pin,
                label: property.name,
                address: property.address ?? null,
                roomTypeIds: rooms.map((room) => room.roomTypeId),
                kind: "property",
                approximate: property.mapDisplayMode === "approximate",
              },
            ]
          : [],
      unpinnedRooms: [],
    };
  }
  // Each room joins the first pin within SAME_PLACE_METRES of it, in room order.
  const groups: LocationMapRoomInput[][] = [];
  for (const room of pinned) {
    const near = groups.find(
      (group) => metresBetween(group[0].pin!, room.pin!) < SAME_PLACE_METRES,
    );
    if (near) near.push(room);
    else groups.push([room]);
  }
  const unpinnedRooms = rooms.filter((room) => !room.pin);
  const everyRoomAtOneSpot = groups.length === 1 && unpinnedRooms.length === 0;
  return {
    pins: groups.map((group) => ({
      ...group[0].pin!,
      label: everyRoomAtOneSpot ? property.name : group.map((room) => room.name).join(", "),
      address: group.find((room) => room.address)?.address ?? null,
      roomTypeIds: group.map((room) => room.roomTypeId),
      kind: everyRoomAtOneSpot ? "property" : "rooms",
      approximate: false,
    })),
    unpinnedRooms,
  };
}
