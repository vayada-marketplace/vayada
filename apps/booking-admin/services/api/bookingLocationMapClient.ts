import type { LocationMapDisplayMode, LocationMapPoint } from "@vayada/domain-hotels";
import type { ApiClient } from "./client";
import { sharedSetupClient } from "./sharedHotelSetupClient";

/** GET/PUT /api/booking/properties/:id/location-map (VAY-2126): the "Location map on your booking page" switch
 * and what guests would see. */
export type LocationMapSummary = {
  enabled: boolean;
  canSwitch: boolean;
  /** Each room's place as guests see it (VAY-2321): at the property, or its own pin, exact or as an area. */
  rooms: {
    roomTypeId: string;
    name: string;
    address: string | null;
    pin: LocationMapPoint | null;
    atProperty: boolean;
    approximate: boolean;
  }[];
  property: {
    name: string;
    address: string | null;
    pin: LocationMapPoint | null;
    mapDisplayMode: LocationMapDisplayMode;
  };
};

type Http = Pick<ApiClient, "get" | "put">;

const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string | null => v === null || typeof v === "string";
const point = (v: unknown): v is LocationMapPoint | null =>
  v === null ||
  (record(v) &&
    typeof v.latitude === "number" &&
    Math.abs(v.latitude) <= 90 &&
    typeof v.longitude === "number" &&
    Math.abs(v.longitude) <= 180);
const path = (propertyId: string) => {
  if (!uuid(propertyId))
    throw new Error("Choose a valid property before editing its location map.");
  return `/api/booking/properties/${propertyId.toLowerCase()}/location-map`;
};

function parseSummary(v: unknown): LocationMapSummary | null {
  if (!record(v) || typeof v.enabled !== "boolean" || typeof v.canSwitch !== "boolean") return null;
  if (!Array.isArray(v.rooms) || !record(v.property)) return null;
  const rooms = v.rooms.every(
    (room) =>
      record(room) &&
      uuid(room.roomTypeId) &&
      typeof room.name === "string" &&
      text(room.address) &&
      point(room.pin) &&
      ["boolean", "undefined"].includes(typeof room.atProperty) &&
      ["boolean", "undefined"].includes(typeof room.approximate),
  );
  const { property } = v;
  if (
    !rooms ||
    typeof property.name !== "string" ||
    !text(property.address) ||
    !point(property.pin) ||
    !["hidden", "approximate", "exact"].includes(property.mapDisplayMode as string)
  )
    return null;
  // An API from before VAY-2321 sends neither flag: a room without a pin of its own is at the property.
  return {
    ...(v as LocationMapSummary),
    rooms: (v.rooms as Record<string, unknown>[]).map((room) => ({
      ...(room as LocationMapSummary["rooms"][number]),
      atProperty: typeof room.atProperty === "boolean" ? room.atProperty : room.pin === null,
      approximate: room.approximate === true,
    })),
  };
}

export function createBookingLocationMapClient(http: Http) {
  return {
    async load(propertyId: string, signal?: AbortSignal): Promise<LocationMapSummary> {
      const summary = parseSummary(
        await http.get<unknown>(path(propertyId), { signal, cache: "no-store" }),
      );
      if (!summary) throw new Error("The location map settings could not be loaded.");
      return summary;
    },
    async save(propertyId: string, enabled: boolean): Promise<boolean> {
      const result = await http.put<unknown>(path(propertyId), { enabled });
      if (!record(result) || typeof result.enabled !== "boolean")
        throw new Error("The save could not be confirmed. Reload to check the result.");
      return result.enabled;
    },
  };
}

// The same client as the page's location and nearby editor: it works with either kind of session.
export const bookingLocationMapClient = createBookingLocationMapClient(sharedSetupClient);
