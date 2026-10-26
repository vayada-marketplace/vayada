import { isSamePlace } from "@vayada/domain-hotels";
import type { QueryResultRow } from "pg";
import { roomAddress, roomAtProperty, roomPin, type MapPin } from "./bookingLocationMap.js";

/** The property's address, arrival directions and pin, for "Where you'll stay" (VAY-2322). */
export type StayPropertyLocation = {
  streetAddress: string | null;
  area: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  arrivalDirections: string | null;
};

/** One place a guest stays at: the property with the booked rooms that are there, or the own address and pin
 * of rooms elsewhere (VAY-2322). Exact even where the booking page shows only an area (D7). */
export type StayPlace =
  | ({ kind: "property"; rooms: string[]; pin: MapPin | null } & Omit<
      StayPropertyLocation,
      "latitude" | "longitude"
    >)
  | {
      kind: "elsewhere";
      rooms: string[];
      address: string | null;
      pin: MapPin | null;
      area: string | null;
      /** The booking page showed only the area of this place. */
      approximate: boolean;
    };

/** The booked room types and their saved places, in booking order, as a jsonb array of {name, attributes}:
 * the PMS's rooms (a room can move to another type; a canceled one is gone), else the booked pricing rooms,
 * else the booked offer's room lines, else its room. Reads `booking`, a booking.guest_bookings row. */
export const BOOKED_ROOM_PLACES_SQL = `(WITH assigned AS (
          SELECT assignment.room_type_id::text AS room_type_id, assignment.position::bigint AS position
          FROM pms.operational_booking_assignments assignment
          WHERE assignment.guest_booking_id = booking.id
            AND assignment.property_id = booking.property_id
            AND assignment.assignment_status <> 'canceled'
            AND NOT (assignment.assignment_status = 'released'
              AND assignment.assignment_payload @> '{"channexAlterationReleased":true}')
        ), selected AS (
          SELECT selection.value->>'roomTypeId' AS room_type_id, selection.position
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(booking.booking_metadata->'pricingSelections') = 'array'
              THEN booking.booking_metadata->'pricingSelections' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS selection(value, position)
        ), offered AS (
          SELECT line.value->>'roomTypeId' AS room_type_id, line.position
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(booking.booking_metadata #> '{selectedOffer,roomLines}') = 'array'
              THEN booking.booking_metadata #> '{selectedOffer,roomLines}' ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS line(value, position)
        ), booked AS (
          SELECT room_type_id, position FROM assigned
          UNION ALL
          SELECT room_type_id, position FROM selected WHERE NOT EXISTS (SELECT 1 FROM assigned)
          UNION ALL
          SELECT room_type_id, position FROM offered
          WHERE NOT EXISTS (SELECT 1 FROM assigned) AND NOT EXISTS (SELECT 1 FROM selected)
          UNION ALL
          SELECT booking.booking_metadata #>> '{selectedOffer,roomTypeId}', 0
          WHERE NOT EXISTS (SELECT 1 FROM assigned) AND NOT EXISTS (SELECT 1 FROM selected)
            AND NOT EXISTS (SELECT 1 FROM offered)
        )
        SELECT COALESCE(jsonb_agg(
                 jsonb_build_object('name', room.name, 'attributes', room.room_attributes)
                 ORDER BY room.first_position), '[]'::jsonb)
        FROM (
          SELECT room_type.name, room_type.room_attributes, min(booked.position) AS first_position
          FROM booked
          JOIN pms.room_types room_type
            ON room_type.id::text = booked.room_type_id
           AND room_type.property_id = booking.property_id
          GROUP BY room_type.id, room_type.name, room_type.room_attributes
        ) room)`;

/** The property's place as a jsonb StayPropertyLocation. Reads `location`, a hotel_catalog.property_locations
 * row. */
export const PROPERTY_PLACE_SQL = `jsonb_build_object(
                'streetAddress', location.street_address, 'area', location.area,
                'postalCode', location.postal_code, 'city', location.city,
                'countryCode', location.country_code,
                'latitude', location.latitude, 'longitude', location.longitude,
                'arrivalDirections', location.arrival_directions)`;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Where the booked rooms are, one entry per place: the property first (with the rooms there), then each place
 * elsewhere. Nothing it can't place: a room elsewhere with nothing saved, or a property without an address or
 * pin. */
export function stayPlaces(
  location: StayPropertyLocation | null,
  rooms: ReadonlyArray<{ name: string; attributes: unknown }>,
): StayPlace[] {
  const propertyPin = location ? roomPin(location) : null;
  const atProperty: string[] = [];
  const elsewhere = new Map<string, Extract<StayPlace, { kind: "elsewhere" }>>();
  for (const room of rooms) {
    const saved = record(room.attributes);
    const pin = roomPin(saved);
    const address = roomAddress(saved);
    // A room on the property's own pin without an address of its own is there, whatever its setting.
    if (
      roomAtProperty(saved, propertyPin) ||
      (!address && pin && propertyPin && isSamePlace(pin, propertyPin))
    ) {
      atProperty.push(room.name);
      continue;
    }
    if (!address && !pin) continue;
    const key = `${address ?? ""}|${pin ? `${pin.latitude},${pin.longitude}` : ""}`;
    const place = elsewhere.get(key) ?? {
      kind: "elsewhere" as const,
      rooms: [],
      address,
      pin,
      area: text(saved["locationArea"]),
      approximate: false,
    };
    place.rooms.push(room.name);
    place.approximate ||= pin !== null && saved["locationPrecision"] === "approximate";
    elsewhere.set(key, place);
  }
  const places: StayPlace[] = [];
  if (
    location &&
    (text(location.streetAddress) || text(location.city) || propertyPin) &&
    (atProperty.length > 0 || rooms.length === 0)
  )
    places.push({
      kind: "property",
      rooms: atProperty,
      streetAddress: text(location.streetAddress),
      area: text(location.area),
      postalCode: text(location.postalCode),
      city: text(location.city),
      countryCode: text(location.countryCode),
      pin: propertyPin,
      arrivalDirections: text(location.arrivalDirections),
    });
  return [...places, ...elsewhere.values()];
}

type Queryable = {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
};

/** A booking's places (VAY-2360: the confirmation page's hotel card and map), as its confirmation email lists
 * them. */
export async function loadStayPlaces(
  queryable: Queryable,
  input: { propertyId: string; guestBookingId: string },
): Promise<StayPlace[]> {
  const result = await queryable.query<{
    propertyLocation: StayPropertyLocation | null;
    bookedRooms: Array<{ name: string; attributes: unknown }> | null;
  }>(
    `SELECT location.place AS "propertyLocation",
       ${BOOKED_ROOM_PLACES_SQL} AS "bookedRooms"
     FROM booking.guest_bookings booking
     LEFT JOIN LATERAL (
       SELECT ${PROPERTY_PLACE_SQL} AS place
       FROM hotel_catalog.property_locations location
       WHERE location.property_id = booking.property_id
       LIMIT 1
     ) location ON TRUE
     WHERE booking.property_id = $1::uuid AND booking.id = $2::uuid`,
    [input.propertyId, input.guestBookingId],
  );
  const row = result.rows[0];
  return row ? stayPlaces(row.propertyLocation, row.bookedRooms ?? []) : [];
}
