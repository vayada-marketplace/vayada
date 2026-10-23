import { randomUUID } from "node:crypto";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";

/** The booking page's location map (VAY-2126): booking_settings.location_map_enabled (0509), the rooms' own
 * pins (room_attributes latitude/longitude, set in PMS) and the property's pin. Off by default. */

export type MapPin = { latitude: number; longitude: number };
export type MapDisplayMode = "hidden" | "approximate" | "exact";

export type LocationMapRoom = {
  roomTypeId: string;
  name: string;
  address: string | null;
  pin: MapPin | null;
};

export type LocationMapSummary = {
  enabled: boolean;
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

export type LocationMapUpdate = {
  propertyId: string;
  enabled: boolean;
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

/** The location map as guests get it; null while the switch is off. */
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
  if (!row?.enabled) return null;
  const pin = roomPin({
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  });
  if (!pin || !row.geoPublic || row.mapDisplayMode === "hidden" || !row.mapDisplayMode)
    return { property: null };
  // The same rounding the booking page publication applies to an approximate location.
  return row.mapDisplayMode === "approximate"
    ? {
        property: {
          latitude: Number(pin.latitude.toFixed(2)),
          longitude: Number(pin.longitude.toFixed(2)),
          approximate: true,
        },
      }
    : { property: { ...pin, approximate: false } };
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
        pool.query<{ enabled: boolean }>(
          `SELECT location_map_enabled AS enabled FROM booking.booking_settings
           WHERE property_id = $1::uuid`,
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
      return {
        enabled: settings.rows[0]?.enabled ?? false,
        canSwitch: settings.rows.length > 0,
        rooms: rooms.rows.map((room) => ({
          roomTypeId: room.roomTypeId,
          name: room.name,
          address: roomAddress(room.attributes),
          pin: roomPin(room.attributes),
        })),
        property: {
          name: place.name,
          address:
            [place.streetAddress, [place.postalCode, place.city].filter(Boolean).join(" ")]
              .map((part) => part?.trim())
              .filter(Boolean)
              .join(", ") || null,
          pin: roomPin({ latitude, longitude }),
          mapDisplayMode: place.geoPublic ? (place.mapDisplayMode ?? "hidden") : "hidden",
        },
      };
    },

    async setEnabled({ propertyId, enabled, audit }) {
      const result = await pool.query<{ enabled: boolean }>(
        `WITH updated AS (
           UPDATE booking.booking_settings SET location_map_enabled = $2::boolean
           WHERE property_id = $1::uuid
           RETURNING location_map_enabled AS enabled
         ), audited AS (
           INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
             actor_type, actor_user_id, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata,
             privacy_scope
           )
           SELECT $3, 'booking',
             CASE WHEN $2::boolean THEN 'booking.location_map.enabled'
                  ELSE 'booking.location_map.disabled' END,
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
          `booking.location-map:${propertyId}:${randomUUID()}`,
          audit.actorUserId,
          audit.correlationId ?? audit.requestId,
          audit.requestId,
          audit.organizationId,
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
