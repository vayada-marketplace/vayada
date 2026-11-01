import { randomUUID } from "node:crypto";
import { isSamePlace } from "@vayada/domain-hotels";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

/** The booking page's location map (VAY-2126): booking_settings.location_map_enabled (0509), the rooms' own
 * pins (room_attributes latitude/longitude, set in PMS) and the property's pin. Off by default. */

export type MapPin = { latitude: number; longitude: number };
export type MapDisplayMode = "hidden" | "approximate" | "exact";

/** A room's place as guests see it (VAY-2321): its own address and pin, or "same as property". */
export type LocationMapRoom = {
  roomTypeId: string;
  name: string;
  /** Its own address, or its area's name when it is shown as an area. */
  address: string | null;
  /** Its own pin, rounded to its area when it is shown as one; null at the property or without a pin. */
  pin: MapPin | null;
  atProperty: boolean;
  approximate: boolean;
};

export type GuestRoomLocation = Omit<LocationMapRoom, "roomTypeId" | "name"> & {
  /** The room's own "Show map in room details" switch: on unless the hotel turned it off. */
  showMapInDetails: boolean;
};

export type LocationMapSummary = {
  enabled: boolean;
  /** The "Show nearby places" switch (VAY-2326), stored and switched the same way. */
  nearbyEnabled: boolean;
  /** False until the hotel has booking settings; the switch then can't be saved yet. */
  canSwitch: boolean;
  /** Operating room types, in the hotel's room order. */
  rooms: LocationMapRoom[];
  property: {
    name: string;
    address: string | null;
    pin: MapPin | null;
    /** What the property's own "Guest map visibility" shows guests; hidden when its location is private. */
    mapDisplayMode: MapDisplayMode;
  };
};

/** The two guest map switches in booking_settings: the location map and its nearby places. */
const SWITCHES = {
  locationMap: { column: "location_map_enabled", action: "booking.location_map" },
  nearbyPlaces: { column: "nearby_places_enabled", action: "booking.nearby_places" },
} as const;

export type LocationMapUpdate = {
  propertyId: string;
  enabled: boolean;
  /** Which switch; the location map when omitted. */
  setting?: keyof typeof SWITCHES;
  audit: {
    actorUserId: string;
    organizationId: string;
    requestId: string;
    correlationId: string | null;
  };
};

export type BookingLocationMapRepository = {
  /** Null when the property doesn't exist. */
  read(propertyId: string): Promise<LocationMapSummary | null>;
  /** Null when the property has no booking settings to switch. */
  setEnabled(command: LocationMapUpdate): Promise<{ enabled: boolean } | null>;
  close?(): Promise<void>;
};

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

/** The property's place on the guest maps (the location map while its switch is on, and the rooms' details). */
export type GuestLocationMap = {
  /** The property's own pin as its "Guest map visibility" shows it: rounded to the area for Approximate,
   * none for Hidden or a private location. Used when no room has a pin of its own. */
  property: (MapPin & { approximate: boolean }) | null;
};

/** Read live, never from the booking page publication: switching the map never makes a live page stale. */
export async function readGuestLocationMap(
  db: Queryable,
  propertyId: string,
): Promise<GuestLocationMap | null> {
  const location = await readGuestLocation(db, propertyId);
  return location?.enabled ? location.map : null;
}

/** The property's place as guests may see it, whether the location map switch (`enabled`) is on, and the
 * property's exact pin to place its rooms by (VAY-2321); never send the latter. A room's own "Show map in room
 * details" works without the switch (VAY-2445). Null until the hotel has booking settings. */
export async function readGuestLocation(
  db: Queryable,
  propertyId: string,
): Promise<{ enabled: boolean; map: GuestLocationMap; propertyPin: MapPin | null } | null> {
  const result = await db.query<{
    enabled: boolean;
    latitude: string | null;
    longitude: string | null;
    geoPublic: boolean | null;
    mapDisplayMode: MapDisplayMode | null;
  }>(
    `SELECT settings.location_map_enabled AS enabled,
            location.latitude::text, location.longitude::text,
            location.geo_public AS "geoPublic", location.map_display_mode AS "mapDisplayMode"
     FROM booking.booking_settings settings
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = settings.property_id
     WHERE settings.property_id = $1::uuid`,
    [propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const enabled = row.enabled === true;
  const pin = roomPin({
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  });
  if (!pin || !row.geoPublic || row.mapDisplayMode === "hidden" || !row.mapDisplayMode)
    return { enabled, map: { property: null }, propertyPin: pin };
  return {
    enabled,
    map:
      row.mapDisplayMode === "approximate"
        ? { property: { ...roundToArea(pin), approximate: true } }
        : { property: { ...pin, approximate: false } },
    propertyPin: pin,
  };
}

/** The same rounding the booking page publication applies to an approximate location: about 1 km. */
function roundToArea(pin: MapPin): MapPin {
  return { latitude: Number(pin.latitude.toFixed(2)), longitude: Number(pin.longitude.toFixed(2)) };
}

/** A room's place as guests see it, from its saved attributes (VAY-2321). A room saved before VAY-2321 has no
 * locationSource: with a pin of its own away from the property it is at its own place, otherwise at the
 * property, so a pin typed on the hotel's own building never shows what its visibility hides. A room shown
 * as an area gets its pin rounded and its area's name instead of its street. */
export function guestRoomLocation(
  attributes: unknown,
  propertyPin: MapPin | null,
): GuestRoomLocation {
  const saved =
    attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  const pin = roomPin(saved);
  const atProperty = roomAtProperty(saved, propertyPin);
  const approximate = !atProperty && pin !== null && saved.locationPrecision === "approximate";
  const area = typeof saved.locationArea === "string" ? saved.locationArea.trim() : "";
  return {
    atProperty,
    approximate,
    pin: atProperty || !pin ? null : approximate ? roundToArea(pin) : pin,
    address: atProperty || !pin ? null : approximate ? area || null : roomAddress(saved),
    showMapInDetails: saved.showMapInDetails !== false,
  };
}

/** Whether a room is at the property: "Same as property", or (saved before VAY-2321) no pin of its own away
 * from the property's. */
export function roomAtProperty(attributes: unknown, propertyPin: MapPin | null): boolean {
  const saved =
    attributes && typeof attributes === "object" ? (attributes as Record<string, unknown>) : {};
  const pin = roomPin(saved);
  return (
    saved.locationSource === "property" ||
    (saved.locationSource !== "custom" &&
      (!pin || (propertyPin !== null && isSamePlace(pin, propertyPin))))
  );
}

/** A room's own pin from its saved attributes; null unless both coordinates are numbers in range. */
export function roomPin(attributes: unknown): MapPin | null {
  if (!attributes || typeof attributes !== "object") return null;
  const { latitude, longitude } = attributes as Record<string, unknown>;
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

export function roomAddress(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const address = (attributes as Record<string, unknown>).locationAddress;
  return typeof address === "string" && address.trim() ? address.trim() : null;
}

type PropertyRow = {
  name: string;
  streetAddress: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  latitude: string | null;
  longitude: string | null;
  geoPublic: boolean | null;
  mapDisplayMode: MapDisplayMode | null;
};

// The switch deliberately leaves booking_settings.updated_at alone: the booking page publication hashes
// that row, and a switch must not make a live page look edited (as VAY-2200's module switches).
export function createPgBookingLocationMapRepository(config: {
  connectionString: string;
  max?: number;
}): BookingLocationMapRepository {
  if (!config.connectionString.trim())
    throw new Error("Booking location map repository connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async read(propertyId) {
      const property = await pool.query<PropertyRow>(
        `SELECT property.display_name AS name,
                location.street_address AS "streetAddress", location.postal_code AS "postalCode",
                location.city, location.country_code AS "countryCode",
                location.latitude::text, location.longitude::text,
                location.geo_public AS "geoPublic", location.map_display_mode AS "mapDisplayMode"
         FROM hotel_catalog.properties property
         LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
         WHERE property.id = $1::uuid`,
        [propertyId],
      );
      const place = property.rows[0];
      if (!place) return null;
      const [settings, rooms] = await Promise.all([
        pool.query<{ enabled: boolean; nearbyEnabled: boolean }>(
          `SELECT location_map_enabled AS enabled, nearby_places_enabled AS "nearbyEnabled"
           FROM booking.booking_settings WHERE property_id = $1::uuid`,
          [propertyId],
        ),
        pool.query<{ roomTypeId: string; name: string; attributes: unknown }>(
          `SELECT room.id::text AS "roomTypeId", room.name, room.room_attributes AS attributes
           FROM pms.room_types room
           LEFT JOIN pms.room_type_closures closure
             ON closure.property_id = room.property_id AND closure.room_type_id = room.id
           WHERE room.property_id = $1::uuid AND room.active AND closure.room_type_id IS NULL
           ORDER BY room.sort_order, room.name, room.id`,
          [propertyId],
        ),
      ]);
      const latitude = place.latitude === null ? null : Number(place.latitude);
      const longitude = place.longitude === null ? null : Number(place.longitude);
      const propertyPin = roomPin({ latitude, longitude });
      return {
        enabled: settings.rows[0]?.enabled ?? false,
        nearbyEnabled: settings.rows[0]?.nearbyEnabled ?? false,
        canSwitch: settings.rows.length > 0,
        rooms: rooms.rows.map((room) => {
          const { atProperty, approximate, pin, address } = guestRoomLocation(
            room.attributes,
            propertyPin,
          );
          return {
            roomTypeId: room.roomTypeId,
            name: room.name,
            address,
            pin,
            atProperty,
            approximate,
          };
        }),
        property: {
          name: place.name,
          address:
            [place.streetAddress, [place.postalCode, place.city].filter(Boolean).join(" ")]
              .map((part) => part?.trim())
              .filter(Boolean)
              .join(", ") || null,
          pin: propertyPin,
          mapDisplayMode: place.geoPublic ? (place.mapDisplayMode ?? "hidden") : "hidden",
        },
      };
    },

    async setEnabled({ propertyId, enabled, setting = "locationMap", audit }) {
      const { column, action } = SWITCHES[setting];
      const result = await pool.query<{ enabled: boolean }>(
        `WITH updated AS (
           UPDATE booking.booking_settings SET ${column} = $2::boolean
           WHERE property_id = $1::uuid
           RETURNING ${column} AS enabled
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           SELECT $3, 'booking', $8::text || CASE WHEN $2::boolean THEN '.enabled' ELSE '.disabled' END,
             now(), 'property', NULL, $1::uuid, 'user', $4::uuid, 'booking', 'booking_hotel',
             $1::uuid::text, $5, $6, jsonb_build_object('enabled', $2::boolean),
             jsonb_build_object('organizationId', $7::uuid), 'internal'
           FROM updated
           RETURNING occurred_at
         )
         SELECT updated.enabled FROM updated CROSS JOIN audited`,
        [
          propertyId,
          enabled,
          `${action.replaceAll("_", "-")}:${propertyId}:${randomUUID()}`,
          audit.actorUserId,
          audit.correlationId ?? audit.requestId,
          audit.requestId,
          audit.organizationId,
          action,
        ],
      );
      const row = result.rows[0];
      return row ? { enabled: row.enabled } : null;
    },

    async close() {
      await pool.end();
    },
  };
}
