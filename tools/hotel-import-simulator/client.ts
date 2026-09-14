import {
  parsePreparedHotelImport,
  type PreparedHotelImport,
  type PreparedRoom,
  type ImportItemResult,
} from "@vayada/domain-hotels";
import type {
  PreparedImportClient,
  PreparedImportResponse,
} from "../../packages/product-onboarding/src/PreparedHotelImportPanel";
export const listings: PreparedRoom[] = [
  {
    id: "synthetic-garden",
    name: "Demo Garden Suite",
    description: "Synthetic garden-view room.",
    maxGuests: 2,
    maxAdults: 2,
    maxChildren: 0,
    bedType: "queen",
    bedQuantity: 1,
    bathroomType: "private",
    sizeSquareMetres: null,
  },
  {
    id: "synthetic-loft",
    name: "Demo Loft",
    description: "",
    maxGuests: null,
    maxAdults: null,
    maxChildren: null,
    bedType: "",
    bedQuantity: null,
    bathroomType: "",
    sizeSquareMetres: null,
  },
];
const key = "vay1009-local-simulator-v1";
export type Ledger = {
  rooms: Record<string, PreparedRoom>;
  results: Record<string, ImportItemResult>;
};
export function readLedger(): Ledger {
  return JSON.parse(sessionStorage.getItem(key) ?? '{"rooms":{},"results":{}}');
}
export function resetLedger() {
  sessionStorage.removeItem(key);
}
// Deliberate fake persistence: this is not the API repository or its idempotency proof.
export function createClient(
  data: PreparedHotelImport,
  scenario: string,
  onPersist: (ledger: Ledger) => void,
): PreparedImportClient {
  let faultPending = true;
  const endpoint = "/api/hotel-setup/properties/synthetic-hotel/import";
  return {
    async get<T>(path: string): Promise<T> {
      if (path !== endpoint) throw new Error("Unexpected simulator endpoint");
      const ledger = readLedger();
      return {
        import: {
          sourceId: "synthetic-source",
          data,
          propertyId: "synthetic-hotel",
          results: ledger.results,
        },
        profile: {
          propertyId: "synthetic-hotel",
          profileRevision: 1,
          profile: {
            displayName: "Local Demo Hotel",
            propertyType: "hotel",
            location: {
              city: "Berlin",
              streetAddress: "",
              postalCode: "",
              countryCode: "DE",
              timezone: "Europe/Berlin",
              latitude: null,
              longitude: null,
              localityPublic: false,
              geoPublic: false,
              mapDisplayMode: "hidden",
            },
            contacts: [],
          },
        },
        canImportRooms: true,
        canImportProperty: false,
        existingRooms: Object.values(ledger.rooms).map((room) => ({
          id: room.id,
          name: room.name,
        })),
      } as PreparedImportResponse as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      if (path !== endpoint) throw new Error("Unexpected simulator endpoint");
      const request = body as { sourceId: string; data: unknown };
      const selected = parsePreparedHotelImport(request.data);
      if (
        request.sourceId !== "synthetic-source" ||
        !selected ||
        selected.rooms.some((room) => !data.rooms.some((source) => source.id === room.id))
      )
        throw new Error("Invalid simulated request");
      const ledger = readLedger();
      const items = selected.rooms.map((room, index): ImportItemResult => {
        const itemId = `room:${room.id}`;
        if (ledger.results[itemId]) return ledger.results[itemId];
        if (
          room.maxGuests === null ||
          room.maxAdults === null ||
          room.maxChildren === null ||
          !room.bathroomType
        )
          return { itemId, status: "failed", error: "incomplete_room_facts" };
        if (scenario === "partial-failure" && faultPending && index === selected.rooms.length - 1) {
          faultPending = false;
          return { itemId, status: "failed", error: "simulated_provider_failure" };
        }
        if (
          Object.values(ledger.rooms).some(
            (saved) => saved.name.trim().toLowerCase() === room.name.trim().toLowerCase(),
          )
        )
          return { itemId, status: "failed", error: "room_type_name_conflict" };
        ledger.rooms[room.id] = room;
        return (ledger.results[itemId] = { itemId, status: "applied", resourceId: room.id });
      });
      sessionStorage.setItem(key, JSON.stringify(ledger));
      onPersist(ledger);
      if (scenario === "lost-response" && faultPending) {
        faultPending = false;
        throw new Error("Simulated lost response after save");
      }
      return { items } as T;
    },
  };
}
