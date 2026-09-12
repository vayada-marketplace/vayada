/** Suggestions only. Accepting this data never establishes ownership or inventory. */
export const PREPARED_HOTEL_IMPORT_VERSION = "prepared-hotel-import.v1" as const;
export const IMPORT_PROPERTY_FIELDS = [
  "displayName",
  "propertyType",
  "streetAddress",
  "postalCode",
  "city",
  "countryCode",
  "timezone",
] as const;
export type ImportPropertyField = (typeof IMPORT_PROPERTY_FIELDS)[number];
export type PreparedRoom = {
  id: string;
  name: string;
  description: string;
  maxGuests: number | null;
  maxAdults: number | null;
  maxChildren: number | null;
  bedType: string;
  bedQuantity: number | null;
  bathroomType: "private" | "shared" | "";
  sizeSquareMetres: number | null;
};
export type PreparedHotelImport = {
  contractVersion: typeof PREPARED_HOTEL_IMPORT_VERSION;
  property: Partial<Record<ImportPropertyField, string>>;
  rooms: PreparedRoom[];
};
export type ImportItemResult = {
  itemId: string;
  status: "applied" | "failed";
  resourceId?: string;
  error?: string;
};

export function parsePreparedHotelImport(value: unknown): PreparedHotelImport | null {
  if (
    !record(value) ||
    !exact(value, ["contractVersion", "property", "rooms"]) ||
    value.contractVersion !== PREPARED_HOTEL_IMPORT_VERSION ||
    !record(value.property) ||
    !Object.keys(value.property).every((key) =>
      IMPORT_PROPERTY_FIELDS.includes(key as ImportPropertyField),
    ) ||
    !Object.values(value.property).every((text) => validText(text, 300)) ||
    !Array.isArray(value.rooms) ||
    value.rooms.length > 50
  )
    return null;
  const rooms = value.rooms.map(parsePreparedRoom);
  if (rooms.some((room) => !room) || new Set(rooms.map((room) => room?.id)).size !== rooms.length)
    return null;
  return {
    contractVersion: PREPARED_HOTEL_IMPORT_VERSION,
    property: { ...value.property } as PreparedHotelImport["property"],
    rooms: rooms as PreparedRoom[],
  };
}

export function parsePreparedRoom(value: unknown): PreparedRoom | null {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "name",
      "description",
      "maxGuests",
      "maxAdults",
      "maxChildren",
      "bedType",
      "bedQuantity",
      "bathroomType",
      "sizeSquareMetres",
    ]) ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(value.id) ||
    !validText(value.name, 200) ||
    !value.name.trim() ||
    !validText(value.description, 5000) ||
    !validText(value.bedType, 80) ||
    typeof value.bathroomType !== "string" ||
    !["", "private", "shared"].includes(value.bathroomType)
  )
    return null;
  for (const field of ["maxGuests", "maxAdults", "maxChildren", "bedQuantity"] as const) {
    const number = value[field];
    if (
      number !== null &&
      (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > 100)
    )
      return null;
  }
  if (
    value.sizeSquareMetres !== null &&
    (typeof value.sizeSquareMetres !== "number" ||
      !Number.isFinite(value.sizeSquareMetres) ||
      value.sizeSquareMetres <= 0 ||
      value.sizeSquareMetres > 10000)
  )
    return null;
  return { ...value } as PreparedRoom;
}

function validText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
