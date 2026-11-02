import {
  createEmptyRoomDraft,
  ROOM_NAME_MAX_LENGTH,
  type CanonicalRoomAuthoringState,
  type RoomAuthoringDraft,
} from "../adaptive/rooms/roomAuthoringState";

/**
 * VAY-2451: the setup's room type is made under the first run's draft id, so the server's first run finds it
 * (it gives that room type the placeholder price) and a resume finds it again.
 */
export const SETUP_ROOM_DRAFT_ID = "first-run-room-1";

/** A new room as the mockup starts it: one room, 2 guests (2 adults), one double bed, a private bathroom. */
export function newSetupRoom(): RoomAuthoringDraft {
  const room = createEmptyRoomDraft(() => SETUP_ROOM_DRAFT_ID);
  return {
    ...room,
    unitCount: "1",
    maxGuests: "2",
    separateOccupancy: true,
    maxAdults: "2",
    maxChildren: "0",
    beds: [{ id: `${SETUP_ROOM_DRAFT_ID}:bed:1`, type: "double", quantity: "1" }],
    bedrooms: "1",
    bathroomType: "private",
    bathrooms: "1",
  };
}

/** The saved room type as the setup edits it. */
export function setupRoomFromSaved(saved: CanonicalRoomAuthoringState): RoomAuthoringDraft {
  const { facts } = saved;
  return {
    ...newSetupRoom(),
    roomTypeId: saved.roomTypeId,
    roomFactsRevision: saved.roomFactsRevision,
    roomUnitsRevision: saved.roomUnitsRevision,
    roomMediaRevision: saved.roomMediaRevision,
    roomAmenitiesRevision: saved.roomAmenitiesRevision,
    name: facts.name,
    unitCount: String(saved.activeUnitCount),
    maxGuests: String(facts.occupancy.maxGuests),
    separateOccupancy: true,
    maxAdults: String(facts.occupancy.maxAdults),
    maxChildren: String(Math.min(facts.occupancy.maxChildren, facts.occupancy.maxGuests)),
    beds: facts.beds.map((bed, index) => ({
      id: `${SETUP_ROOM_DRAFT_ID}:bed:${index + 1}`,
      type: bed.type,
      quantity: String(bed.quantity),
    })),
    bathroomType: facts.bathroomType,
    bathrooms: facts.bathroomType === "private" ? String(facts.bathrooms ?? 1) : "0",
    description: facts.description,
    category: facts.category ?? "",
    bedrooms: facts.bedrooms === null ? "" : String(facts.bedrooms),
    sizeSquareMetres: facts.size ? String(facts.size.value) : "",
    photos: saved.photos.map((photo) => ({
      mediaObjectId: photo.mediaObjectId,
      previewUrl: photo.publicUrl,
      uploadState: "ready" as const,
      errorMessage: null,
    })),
    amenityKeys: [...saved.amenityKeys],
    reviewedEmptyAmenities: saved.amenitiesReviewed,
    saved: true,
    dirty: false,
  };
}

const whole = (value: string, min: number, max: number) =>
  /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;

/**
 * Why "Room basics" can't continue yet, or null. The mockup asks for a name and a size first; the rest
 * starts filled, so its limits only show when a change breaks them.
 */
export function roomBasicsHint(room: RoomAuthoringDraft): string | null {
  const name = room.name.trim();
  const size = Number(room.sizeSquareMetres);
  if (!name || !(room.sizeSquareMetres.trim() && size > 0))
    return "Add a room name and size to continue";
  if (name.length > ROOM_NAME_MAX_LENGTH)
    return `Use ${ROOM_NAME_MAX_LENGTH} characters or fewer for the name`;
  if (size > 100_000) return "Check the room size";
  if (!whole(room.unitCount, 1, 500)) return "Rooms of this type: 1 to 500";
  if (!whole(room.maxGuests, 1, 100)) return "Total max occupancy: 1 to 100";
  const total = Number(room.maxGuests);
  if (!whole(room.maxAdults, 1, total)) return "Max adults: at least 1, no more than the total";
  if (!whole(room.maxChildren, 0, total)) return "Max children: no more than the total";
  if (Number(room.maxAdults) + Number(room.maxChildren) < total)
    return "Max adults and children together must reach the total";
  if (room.beds.length === 0 || room.beds.some((bed) => !bed.type || !whole(bed.quantity, 1, 20)))
    return "Choose each bed type";
  return null;
}

/** "Private bathrooms" sets the bathroom type: none private means shared. */
export function withPrivateBathrooms(room: RoomAuthoringDraft, count: number): RoomAuthoringDraft {
  return count > 0
    ? { ...room, bathroomType: "private", bathrooms: String(count) }
    : { ...room, bathroomType: "shared", bathrooms: "0" };
}

/** Where guests see the room (VAY-2321's choice in Rooms & Rates): the property's address, or its own. */
export type SetupRoomLocation = Readonly<{
  source: "property" | "custom";
  address: string;
  showMap: boolean;
}>;

export const SAME_AS_PROPERTY: SetupRoomLocation = Object.freeze({
  source: "property",
  address: "",
  showMap: true,
});

/** The room type's location, as Rooms & Rates saves it (the PMS room type update). */
export function setupRoomLocationUpdate(location: SetupRoomLocation, commandId: string) {
  return location.source === "property"
    ? { locationSource: "property", showMapInDetails: true, commandId, idempotencyKey: commandId }
    : {
        locationSource: "custom",
        locationAddress: location.address.trim(),
        showMapInDetails: location.showMap,
        commandId,
        idempotencyKey: commandId,
      };
}
