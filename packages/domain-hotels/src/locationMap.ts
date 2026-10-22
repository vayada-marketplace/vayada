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
};

export type LocationMapPins = {
  pins: LocationMapPin[];
  /** Rooms without a pin of their own while other rooms have one: they're left off the map. */
  unpinnedRooms: LocationMapRoomInput[];
};

// Five decimals is about a metre: two rooms typed at "the same" spot share one pin.
const key = ({ latitude, longitude }: LocationMapPoint) =>
  `${latitude.toFixed(5)},${longitude.toFixed(5)}`;

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
              },
            ]
          : [],
      unpinnedRooms: [],
    };
  }
  const groups = new Map<string, LocationMapRoomInput[]>();
  for (const room of pinned)
    groups.set(key(room.pin!), [...(groups.get(key(room.pin!)) ?? []), room]);
  const unpinnedRooms = rooms.filter((room) => !room.pin);
  const everyRoomAtOneSpot = groups.size === 1 && unpinnedRooms.length === 0;
  return {
    pins: [...groups.values()].map((group) => ({
      ...group[0].pin!,
      label: everyRoomAtOneSpot ? property.name : group.map((room) => room.name).join(", "),
      address: group.find((room) => room.address)?.address ?? null,
      roomTypeIds: group.map((room) => room.roomTypeId),
      kind: everyRoomAtOneSpot ? "property" : "rooms",
    })),
    unpinnedRooms,
  };
}
