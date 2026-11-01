/** Settings › Room Sorting (VAY-2449): the guest sort menu's switch, one-room auto-hide, the six options in
 * the menu's order with each one shown or not, and the default. Saved through next-api (part 1). */
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
  options: { key: RoomSortKey; enabled: boolean }[];
  defaultOption: RoomSortKey;
};

const shownCount = (sorting: RoomSorting) => sorting.options.filter((o) => o.enabled).length;

/** Show or hide an option. The last one shown stays shown; hiding the default moves the default to the
 * first option still shown. */
export function toggleOption(sorting: RoomSorting, key: RoomSortKey): RoomSorting {
  const option = sorting.options.find((o) => o.key === key);
  if (!option || (option.enabled && shownCount(sorting) === 1)) return sorting;
  const options = sorting.options.map((o) => (o.key === key ? { ...o, enabled: !o.enabled } : o));
  const defaultOption =
    key === sorting.defaultOption && option.enabled
      ? options.find((o) => o.enabled)!.key
      : sorting.defaultOption;
  return { ...sorting, options, defaultOption };
}

/** The default must be shown; another one is ignored. */
export function setDefault(sorting: RoomSorting, key: RoomSortKey): RoomSorting {
  return sorting.options.some((o) => o.key === key && o.enabled)
    ? { ...sorting, defaultOption: key }
    : sorting;
}

/** Move an option to another place in the menu (drag, or the arrow keys on its handle). */
export function moveOption(sorting: RoomSorting, key: RoomSortKey, to: number): RoomSorting {
  const from = sorting.options.findIndex((o) => o.key === key);
  if (from < 0 || to < 0 || to >= sorting.options.length || to === from) return sorting;
  const options = [...sorting.options];
  const [moved] = options.splice(from, 1);
  options.splice(to, 0, moved!);
  return { ...sorting, options };
}

/** The options a guest's menu shows, in order. */
export const shownOptions = (sorting: RoomSorting): RoomSortKey[] =>
  sorting.options.filter((o) => o.enabled).map((o) => o.key);
