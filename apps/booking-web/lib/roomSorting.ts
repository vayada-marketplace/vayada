/** The hotel's Room Sorting (VAY-2449), as the room catalogue sends it once the hotel saved its own: whether
 * guests can sort, whether the menu hides for a single room, the menu's options in order and the default. */
export const ROOM_SORT_KEYS = [
  "recommended",
  "priceLow",
  "priceHigh",
  "roomSize",
  "capacity",
  "bestDeal",
] as const;
export type RoomSortKey = (typeof ROOM_SORT_KEYS)[number];

export type RoomSorting = {
  enabled: boolean;
  hideWithOneRoom: boolean;
  /** The options guests see, in the menu's order. */
  options: RoomSortKey[];
  defaultOption: RoomSortKey;
};

/** Every hotel that saved nothing: today's four options, Recommended first and default, no menu for one
 * room. */
export const DEFAULT_ROOM_SORTING: RoomSorting = {
  enabled: true,
  hideWithOneRoom: true,
  options: ["recommended", "priceLow", "priceHigh", "roomSize"],
  defaultOption: "recommended",
};

const isSortKey = (value: unknown): value is RoomSortKey =>
  ROOM_SORT_KEYS.includes(value as RoomSortKey);

/** The catalogue's `roomSorting`, read leniently like next-api reads what it saved: options this page doesn't
 * know are left out, missing switches take the defaults, and a default it can't show is the first option
 * left. Null (the defaults) when it is missing or no option is left. */
export function catalogRoomSorting(raw: unknown): RoomSorting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { enabled, hideWithOneRoom, options, defaultOption } = raw as Record<string, unknown>;
  // booking-web targets ES5: no Set spread.
  const known = Array.isArray(options)
    ? options.filter(isSortKey).filter((key, index, list) => list.indexOf(key) === index)
    : [];
  if (!known.length) return null;
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_ROOM_SORTING.enabled,
    hideWithOneRoom:
      typeof hideWithOneRoom === "boolean" ? hideWithOneRoom : DEFAULT_ROOM_SORTING.hideWithOneRoom,
    options: known,
    defaultOption: known.includes(defaultOption as RoomSortKey)
      ? (defaultOption as RoomSortKey)
      : known[0]!,
  };
}

/** The menu for the rooms on the page: the order they're in (the guest's pick while it is one of the
 * options, else the default; the hotel's own order while sorting is off), and the options to show, none
 * when the menu is hidden: sorting off, fewer than two options, or one room with "Hide when there is only
 * one room". */
export function sortMenu(
  sorting: RoomSorting,
  rooms: number,
  picked: RoomSortKey | null,
): { order: RoomSortKey; options: RoomSortKey[] } {
  if (!sorting.enabled) return { order: "recommended", options: [] };
  const order = picked && sorting.options.includes(picked) ? picked : sorting.defaultOption;
  const hidden = sorting.options.length < 2 || (sorting.hideWithOneRoom && rooms === 1);
  return { order, options: hidden ? [] : sorting.options };
}
