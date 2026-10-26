/** Hotel-owned curation. Provider display content is deliberately absent. */
export const NEARBY_CATEGORIES = ["nature", "food", "activities", "transport"] as const;
export type NearbyCategory = (typeof NEARBY_CATEGORIES)[number];
export const NEARBY_MAX_REQUEST_BYTES = 65_536;

/** VAY-2326: the four categories keep their stored keys and get these colours and icons, in this order: Food &
 * drink, Beach & surf, Sights, Getting around. Hosts can rename them, not delete them, and add their own. */
export const NEARBY_DEFAULT_CATEGORIES = [
  { id: "food", color: "orange", icon: "cake" },
  { id: "nature", color: "teal", icon: "sun" },
  { id: "activities", color: "purple", icon: "camera" },
  { id: "transport", color: "slate", icon: "map" },
] as const satisfies readonly { id: NearbyCategory; color: string; icon: string }[];
/** The colours and icons a host picks from for a category of their own. */
export const NEARBY_CUSTOM_CATEGORY_COLORS = [
  "red",
  "amber",
  "green",
  "sky",
  "indigo",
  "pink",
  "stone",
] as const;
export const NEARBY_CATEGORY_ICONS = [
  "musical-note",
  "cake",
  "sun",
  "camera",
  "map",
  "heart",
  "star",
  "shopping-bag",
] as const;
export const NEARBY_MAX_CUSTOM_CATEGORIES = 8;
export const NEARBY_CATEGORY_NAME_MAX_LENGTH = 24;
/** New and changed tips (VAY-2326). A note saved before keeps up to 500 characters until the host changes it. */
export const NEARBY_TIP_MAX_LENGTH = 140;
export type NearbyCategoryColor =
  | (typeof NEARBY_DEFAULT_CATEGORIES)[number]["color"]
  | (typeof NEARBY_CUSTOM_CATEGORY_COLORS)[number];
export type NearbyCategoryIcon = (typeof NEARBY_CATEGORY_ICONS)[number];
export type NearbyCustomCategory = {
  id: string;
  name: string;
  color: (typeof NEARBY_CUSTOM_CATEGORY_COLORS)[number];
  icon: NearbyCategoryIcon;
};
/** The host's own names for the four categories; a category without one keeps its translated name. */
export type NearbyCategoryNames = Partial<Record<NearbyCategory, string>>;

export type NearbyChoice = {
  placeId: string;
  category: NearbyCategory;
  hidden: boolean;
  favorite: boolean;
  added: boolean;
  note: string | null;
};
export type NearbyCustomPlace = {
  id: string;
  /** One of NEARBY_CATEGORIES, or the ID of one of the host's own categories. */
  category: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  favorite: boolean;
  hidden: boolean;
  note: string | null;
};
/** customPlaces is in the host's order, which guests see (VAY-2326). */
export type NearbyCuration = {
  choices: NearbyChoice[];
  customPlaces: NearbyCustomPlace[];
  customCategories: NearbyCustomCategory[];
  categoryNames: NearbyCategoryNames;
};
/** An omitted choices, customCategories or categoryNames keeps what is saved: the v1 editor doesn't show Google
 * choices (VAY-2326), and editors from before VAY-2326 don't send categories. */
export type NearbyCurationWrite = Pick<NearbyCuration, "customPlaces"> &
  Partial<Omit<NearbyCuration, "customPlaces">> & {
    schemaVersion: 1;
    expectedProfileRevision: number;
    expectedCurationRevision: number;
  };
export type NearbyCurationState = NearbyCuration & {
  schemaVersion: 1;
  profileRevision: number;
  curationRevision: number;
  /** Last profile revision against which the host saved these choices. */
  savedProfileRevision: number | null;
};
export type NearbyWriteError =
  | "invalid_request"
  | "payload_too_large"
  | "revision_conflict"
  | "unknown_place";
export type NearbyParseResult =
  | { ok: true; value: NearbyCurationWrite }
  | { ok: false; code: NearbyWriteError };

const WRITE_KEYS = [
  "schemaVersion",
  "expectedProfileRevision",
  "expectedCurationRevision",
  "customPlaces",
];
const OPTIONAL_WRITE_KEYS = ["choices", "customCategories", "categoryNames"];
const CHOICE_KEYS = ["placeId", "category", "hidden", "favorite", "added", "note"];
const CUSTOM_KEYS = [
  "id",
  "category",
  "name",
  "address",
  "latitude",
  "longitude",
  "favorite",
  "hidden",
  "note",
];
const CATEGORY_KEYS = ["id", "name", "color", "icon"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNearbyCurationWrite(input: unknown): NearbyParseResult {
  if (
    !recordWithKeys(input, WRITE_KEYS, OPTIONAL_WRITE_KEYS) ||
    input.schemaVersion !== 1 ||
    !revision(input.expectedProfileRevision) ||
    !revision(input.expectedCurationRevision) ||
    (input.choices !== undefined &&
      (!Array.isArray(input.choices) || input.choices.length > 100)) ||
    !Array.isArray(input.customPlaces) ||
    input.customPlaces.length > 20 ||
    (input.customCategories !== undefined &&
      (!Array.isArray(input.customCategories) ||
        input.customCategories.length > NEARBY_MAX_CUSTOM_CATEGORIES))
  )
    return invalid();

  let choices: NearbyChoice[] | undefined;
  if (Array.isArray(input.choices)) {
    choices = [];
    for (const choice of input.choices) {
      if (
        !recordWithKeys(choice, CHOICE_KEYS) ||
        !isNearbyPlaceId(choice.placeId) ||
        !category(choice.category) ||
        !flags(choice) ||
        typeof choice.added !== "boolean" ||
        !text(choice.note, 500, true)
      )
        return invalid();
      choices.push({
        placeId: choice.placeId,
        category: choice.category,
        hidden: choice.hidden as boolean,
        favorite: choice.favorite as boolean,
        added: choice.added,
        note: normalize(choice.note as string | null),
      });
    }
  }
  const customPlaces: NearbyCustomPlace[] = [];
  for (const place of input.customPlaces) {
    if (
      !recordWithKeys(place, CUSTOM_KEYS) ||
      typeof place.id !== "string" ||
      !UUID.test(place.id) ||
      !(
        category(place.category) ||
        (typeof place.category === "string" && UUID.test(place.category))
      ) ||
      !flags(place) ||
      !text(place.name, 120, false) ||
      !text(place.address, 300, true) ||
      !text(place.note, 500, true) ||
      !coordinate(place.latitude, 90) ||
      !coordinate(place.longitude, 180)
    )
      return invalid();
    customPlaces.push({
      id: place.id.toLowerCase(),
      category: (place.category as string).toLowerCase(),
      name: (place.name as string).trim(),
      address: normalize(place.address as string | null),
      latitude: place.latitude,
      longitude: place.longitude,
      favorite: place.favorite as boolean,
      hidden: place.hidden as boolean,
      note: normalize(place.note as string | null),
    });
  }
  let customCategories: NearbyCustomCategory[] | undefined;
  if (Array.isArray(input.customCategories)) {
    customCategories = [];
    for (const item of input.customCategories) {
      if (
        !recordWithKeys(item, CATEGORY_KEYS) ||
        typeof item.id !== "string" ||
        !UUID.test(item.id) ||
        !text(item.name, NEARBY_CATEGORY_NAME_MAX_LENGTH, false) ||
        !oneOf(item.color, NEARBY_CUSTOM_CATEGORY_COLORS) ||
        !oneOf(item.icon, NEARBY_CATEGORY_ICONS)
      )
        return invalid();
      customCategories.push({
        id: item.id.toLowerCase(),
        name: (item.name as string).trim(),
        color: item.color,
        icon: item.icon,
      });
    }
  }
  let categoryNames: NearbyCategoryNames | undefined;
  if (input.categoryNames !== undefined) {
    const names = input.categoryNames;
    if (
      !recordWithKeys(names, [], NEARBY_CATEGORIES) ||
      Object.values(names).some((name) => !text(name, NEARBY_CATEGORY_NAME_MAX_LENGTH, false))
    )
      return invalid();
    categoryNames = Object.fromEntries(
      NEARBY_CATEGORIES.filter((key) => Object.hasOwn(names, key)).map((key) => [
        key,
        (names[key] as string).trim(),
      ]),
    );
  }
  if (
    (choices && new Set(choices.map(({ placeId }) => placeId)).size !== choices.length) ||
    new Set(customPlaces.map(({ id }) => id)).size !== customPlaces.length ||
    (customCategories &&
      new Set(customCategories.map(({ id }) => id)).size !== customCategories.length) ||
    (choices && choices.filter(({ added }) => added).length + customPlaces.length > 20) ||
    (customCategories && unknownCategory(customPlaces, customCategories))
  )
    return invalid();

  const value: NearbyCurationWrite = {
    schemaVersion: 1,
    expectedProfileRevision: input.expectedProfileRevision,
    expectedCurationRevision: input.expectedCurationRevision,
    ...(choices && { choices }),
    customPlaces,
    ...(customCategories && { customCategories }),
    ...(categoryNames && { categoryNames }),
  };
  // The HTTP adapter must also enforce the raw body limit before JSON parsing.
  if (new TextEncoder().encode(JSON.stringify(value)).length > NEARBY_MAX_REQUEST_BYTES) {
    return { ok: false, code: "payload_too_large" };
  }
  return { ok: true, value };
}

/** The curation a write saves: what it sends, and what is saved for the parts it leaves out. */
export function mergeNearbyCurationWrite(
  write: NearbyCurationWrite,
  current: NearbyCuration,
): NearbyCuration {
  return {
    choices: write.choices ?? current.choices,
    customPlaces: write.customPlaces,
    customCategories: write.customCategories ?? current.customCategories,
    categoryNames: write.categoryNames ?? current.categoryNames,
  };
}

/** Call under the same transaction/lock as persistence, with trusted property-scoped IDs. */
export function checkNearbyCurationWrite(
  write: NearbyCurationWrite,
  current: NearbyCurationState,
  discoveredPlaceIds: ReadonlySet<string>,
): NearbyWriteError | null {
  if (
    write.expectedProfileRevision !== current.profileRevision ||
    write.expectedCurationRevision !== current.curationRevision
  )
    return "revision_conflict";
  const next = mergeNearbyCurationWrite(write, current);
  // Reads re-check the saved row against the same limit, so what a write keeps counts too.
  if (
    new TextEncoder().encode(JSON.stringify({ ...write, ...next })).length >
    NEARBY_MAX_REQUEST_BYTES
  )
    return "payload_too_large";
  // A note longer than a tip may stay only as it was saved (VAY-2326).
  const savedNotes = new Map<string, string | null>([
    ...current.choices.map(({ placeId, note }) => [`google:${placeId}`, note] as const),
    ...current.customPlaces.map(({ id, note }) => [`custom:${id}`, note] as const),
  ]);
  const longNote = (key: string, note: string | null) =>
    note !== null && note.length > NEARBY_TIP_MAX_LENGTH && savedNotes.get(key) !== note;
  if (
    next.choices.filter(({ added }) => added).length + next.customPlaces.length > 20 ||
    unknownCategory(next.customPlaces, next.customCategories) ||
    next.customPlaces.some(({ id, note }) => longNote(`custom:${id}`, note)) ||
    (write.choices ?? []).some(({ placeId, note }) => longNote(`google:${placeId}`, note))
  )
    return "invalid_request";
  // Only validated persisted choices qualify; legacy imports must not enter this set unchecked.
  const savedIds = new Set(current.choices.map(({ placeId }) => placeId));
  return (write.choices ?? []).some(
    ({ placeId }) => !savedIds.has(placeId) && !discoveredPlaceIds.has(placeId),
  )
    ? "unknown_place"
    : null;
}

export function isNearbyPlaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
}
function recordWithKeys(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
  );
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
/** A place in a category that is neither one of the four nor one of the host's own. */
function unknownCategory(places: NearbyCustomPlace[], categories: NearbyCustomCategory[]): boolean {
  const ids = new Set<string>([...NEARBY_CATEGORIES, ...categories.map(({ id }) => id)]);
  return places.some((place) => !ids.has(place.category));
}
function revision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  );
}
function category(value: unknown): value is NearbyCategory {
  return typeof value === "string" && (NEARBY_CATEGORIES as readonly string[]).includes(value);
}
function flags(value: Record<string, unknown>): boolean {
  return (
    typeof value.hidden === "boolean" &&
    typeof value.favorite === "boolean" &&
    !(value.hidden && value.favorite)
  );
}
function text(value: unknown, max: number, nullable: boolean): boolean {
  if (value === null) return nullable;
  return (
    typeof value === "string" &&
    value.length <= max &&
    (nullable || value.trim().length > 0) &&
    !/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)
  );
}
function normalize(value: string | null): string | null {
  return value?.trim() || null;
}
function coordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}
function invalid(): NearbyParseResult {
  return { ok: false, code: "invalid_request" };
}
