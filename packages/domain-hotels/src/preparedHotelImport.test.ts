import { describe, expect, it } from "vitest";
import { parsePreparedHotelImport, PREPARED_HOTEL_IMPORT_VERSION } from "./preparedHotelImport.js";
const room = {
  id: "room-1",
  name: "Suite",
  description: "",
  maxGuests: null,
  maxAdults: null,
  maxChildren: null,
  bedType: "",
  bedQuantity: null,
  bathroomType: "",
  sizeSquareMetres: null,
};
const data = {
  contractVersion: PREPARED_HOTEL_IMPORT_VERSION,
  property: { displayName: "Hotel" },
  rooms: [room],
};
describe("prepared hotel data", () => {
  it("preserves unknown facts rather than inventing capacity", () =>
    expect(parsePreparedHotelImport(data)).toEqual(data));
  it.each([
    { ...data, property: { ownerId: "other" } },
    { ...data, rates: [] },
    { ...data, rooms: [room, room] },
    { ...data, rooms: [{ ...room, id: "../room" }] },
    { ...data, rooms: [{ ...room, name: " " }] },
    { ...data, rooms: [{ ...room, maxGuests: -1 }] },
    { ...data, rooms: [{ ...room, maxGuests: 1.5 }] },
    { ...data, rooms: [{ ...room, sizeSquareMetres: Infinity }] },
    { ...data, rooms: Array.from({ length: 51 }, (_, i) => ({ ...room, id: `r-${i}` })) },
  ])("rejects unbounded or unsupported payload %j", (value) =>
    expect(parsePreparedHotelImport(value)).toBeNull(),
  );
});
