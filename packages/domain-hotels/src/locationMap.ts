/** The booking page's location map (VAY-2126): which pins guests see, for Booking Admin's summary and the guest
 * map alike. Rooms "Same as property" (VAY-2321) share the property's pin, as its "Guest map visibility" allows;
 * rooms at their own address get their own pin; rooms at one spot share a pin. */

export type LocationMapPoint = { latitude: number; longitude: number };
export type LocationMapDisplayMode = "hidden" | "approximate" | "exact";

export type LocationMapRoomInput = {
  roomTypeId: string;
  name: string;
  /** Its own address, or its area when it is shown as one. */
  address?: string | null;
  /** The room's own place ("Separate location"); null when it has none. */
  pin: LocationMapPoint | null;
  /** "Same as property": the room is at the property and shares its pin. */
  atProperty?: boolean;
  /** Its own place is shown as an area ("Approximate area"), not an exact spot. */
  approximate?: boolean;
};

export type LocationMapPropertyInput = {
  name: string;
  address?: string | null;
  pin: LocationMapPoint | null;
  mapDisplayMode: LocationMapDisplayMode;
};

export type LocationMapPin = LocationMapPoint & {
  /** The property's name when the pin stands for the property, otherwise its rooms' names. */
  label: string;
  address: string | null;
  roomTypeIds: string[];
  kind: "rooms" | "property";
  /** Rounded to its area ("Approximate"): drawn as an area, not an exact spot. */
  approximate: boolean;
};

export type LocationMapPins = {
  pins: LocationMapPin[];
  /** Rooms with a location of their own that has no pin yet: they're left off the map. */
  unpinnedRooms: LocationMapRoomInput[];
  /** Rooms at the property while the property's pin is hidden or missing: they're left off the map too. */
  propertyRoomsOffMap: LocationMapRoomInput[];
};

// Rooms closer than this share one pin: the same building, typed or dragged a few metres apart.
const SAME_PLACE_METRES = 25;

/** Straight-line distance: plenty for a villa a few kilometres from its main property. */
export function metresBetween(a: LocationMapPoint, b: LocationMapPoint): number {
  const toRadians = Math.PI / 180;
  const x =
    (b.longitude - a.longitude) * toRadians * Math.cos(((a.latitude + b.latitude) / 2) * toRadians);
  const y = (b.latitude - a.latitude) * toRadians;
  return Math.hypot(x, y) * 6_371_000;
}

/** Two pins guests would see as one place: within SAME_PLACE_METRES of each other. */
export function isSamePlace(a: LocationMapPoint, b: LocationMapPoint): boolean {
  return metresBetween(a, b) < SAME_PLACE_METRES;
}

type Group = {
  pin: LocationMapPoint;
  approximate: boolean;
  rooms: LocationMapRoomInput[];
  property: boolean;
};

export function locationMapPins(
  rooms: readonly LocationMapRoomInput[],
  property: LocationMapPropertyInput,
): LocationMapPins {
  const propertyGroup: Group | null =
    property.pin && property.mapDisplayMode !== "hidden"
      ? {
          pin: property.pin,
          approximate: property.mapDisplayMode === "approximate",
          rooms: [],
          property: true,
        }
      : null;
  const ownGroups: Group[] = [];
  const unpinnedRooms: LocationMapRoomInput[] = [];
  const propertyRoomsOffMap: LocationMapRoomInput[] = [];
  for (const room of rooms) {
    if (!room.pin) {
      if (!room.atProperty) unpinnedRooms.push(room);
      else if (propertyGroup) propertyGroup.rooms.push(room);
      else propertyRoomsOffMap.push(room);
      continue;
    }
    // Each room joins the first place within SAME_PLACE_METRES shown the same way (an exact spot or an
    // area), in room order; an exact room that close to the property's exact pin is at the property. A room
    // shown as an area keeps its own place: rounded, it may share the property's area by chance.
    const approximate = room.approximate === true;
    const near = [...ownGroups, ...(propertyGroup && !approximate ? [propertyGroup] : [])].find(
      (group) => group.approximate === approximate && isSamePlace(group.pin, room.pin!),
    );
    if (near) near.rooms.push(room);
    else ownGroups.push({ pin: room.pin, approximate, rooms: [room], property: false });
  }
  const groups = [
    ...(propertyGroup && propertyGroup.rooms.length > 0 ? [propertyGroup] : []),
    ...ownGroups,
  ];
  // One exact spot for every room: guests see the property's name, as for a hotel at one address.
  const everyRoomAtOneSpot =
    groups.length === 1 && !groups[0].approximate && groups[0].rooms.length === rooms.length;
  return {
    pins: groups.map((group) => {
      const asProperty = group.property || everyRoomAtOneSpot;
      return {
        ...group.pin,
        label: asProperty ? property.name : group.rooms.map((room) => room.name).join(", "),
        address: group.property
          ? (property.address ?? null)
          : (group.rooms.find((room) => room.address)?.address ?? null),
        roomTypeIds: group.rooms.map((room) => room.roomTypeId),
        kind: asProperty ? "property" : "rooms",
        approximate: group.approximate,
      };
    }),
    unpinnedRooms,
    propertyRoomsOffMap,
  };
}
