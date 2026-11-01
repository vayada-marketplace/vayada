import { ROOM_SORT_KEYS, type RoomSortKey, type RoomSorting } from "@/lib/utils/roomSorting";
import type { ApiClient } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/** GET/PUT /api/booking/properties/:id/room-sorting (VAY-2449): the hotel's Room Sorting, its defaults, and
 * whether it can be saved yet (false until the hotel has booking settings). */
export type RoomSortingSummary = { sorting: RoomSorting; defaults: RoomSorting; canSave: boolean };

type Http = Pick<ApiClient, "get" | "put">;

const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const path = (propertyId: string) => {
  if (!uuid(propertyId))
    throw new Error("Choose a valid property before editing its room sorting.");
  return `/api/booking/properties/${propertyId.toLowerCase()}/room-sorting`;
};

/** Every option once, at least one shown, and a shown default, as next-api saves it. */
export function parseRoomSorting(v: unknown): RoomSorting | null {
  if (!record(v) || typeof v.enabled !== "boolean" || typeof v.hideWithOneRoom !== "boolean")
    return null;
  if (!Array.isArray(v.options) || v.options.length !== ROOM_SORT_KEYS.length) return null;
  const options = v.options.flatMap((o) =>
    record(o) && ROOM_SORT_KEYS.includes(o.key as RoomSortKey) && typeof o.enabled === "boolean"
      ? [{ key: o.key as RoomSortKey, enabled: o.enabled }]
      : [],
  );
  if (new Set(options.map((o) => o.key)).size !== ROOM_SORT_KEYS.length) return null;
  if (!options.some((o) => o.enabled && o.key === v.defaultOption)) return null;
  return {
    enabled: v.enabled,
    hideWithOneRoom: v.hideWithOneRoom,
    options,
    defaultOption: v.defaultOption as RoomSortKey,
  };
}

export function createBookingRoomSortingClient(http: Http) {
  return {
    async load(propertyId: string, signal?: AbortSignal): Promise<RoomSortingSummary> {
      const v = await http.get<unknown>(path(propertyId), { signal, cache: "no-store" });
      const sorting = record(v) ? parseRoomSorting(v.sorting) : null;
      const defaults = record(v) ? parseRoomSorting(v.defaults) : null;
      if (!sorting || !defaults || !record(v) || typeof v.canSave !== "boolean")
        throw new Error("The room sorting settings could not be loaded.");
      return { sorting, defaults, canSave: v.canSave };
    },
    async save(propertyId: string, sorting: RoomSorting): Promise<RoomSorting> {
      const v = await http.put<unknown>(path(propertyId), sorting);
      const saved = record(v) ? parseRoomSorting(v.sorting) : null;
      if (!saved) throw new Error("The save could not be confirmed. Reload to check the result.");
      return saved;
    },
  };
}

// As the location map's client: it works with either kind of session.
export const bookingRoomSortingClient = createBookingRoomSortingClient(sharedSetupClient);
