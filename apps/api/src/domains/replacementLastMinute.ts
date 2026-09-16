import { createHash } from "node:crypto";
import { parseBookingPromotions } from "@vayada/domain-booking";
import { pricingDate, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import {
  lastMinuteBasisPoints,
  parseLastMinuteTiers,
  parseRoomLastMinutePolicy,
} from "./lastMinutePolicy.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Current Booking last-minute owner. Caller has authorized the property and owns
 * its READ COMMITTED transaction. No same-day/calendar/inventory permission is implied.
 * An absent ROOM head is explicit inheritance; missing HOTEL evidence is unavailable. */
export async function lockReplacementLastMinute(
  client: PoolClient,
  input: { propertyId: string; checkIn: string; roomTypeIds: readonly string[] },
) {
  if (
    !input ||
    !uuid(input.propertyId) ||
    !pricingDate(input.checkIn) ||
    !Array.isArray(input.roomTypeIds) ||
    !input.roomTypeIds.length ||
    input.roomTypeIds.length > 99 ||
    !input.roomTypeIds.every(uuid)
  )
    return null;
  const propertyId = input.propertyId.toLowerCase(),
    checkIn = input.checkIn,
    roomTypeIds = input.roomTypeIds.map((r) => r.toLowerCase());
  if (new Set(roomTypeIds).size !== roomTypeIds.length) return null;
  await lockPmsInventoryMutationScope(client, propertyId);
  if (
    !(
      await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
        propertyId,
      ])
    ).rowCount
  )
    return null;
  const row = (
    await client.query(
      `SELECT s.last_minute_discount,l.timezone FROM booking.booking_settings s
    JOIN hotel_catalog.property_locations l USING(property_id) WHERE s.property_id=$1 FOR SHARE OF s,l`,
      [propertyId],
    )
  ).rows[0];
  const hotel = row?.last_minute_discount;
  if (
    !pricingObject(hotel) ||
    !pricingKeys(hotel, [
      "enabled",
      "stackWithPromo",
      "tiers",
      ...(Object.hasOwn(hotel, "promotions") ? ["promotions"] : []),
    ]) ||
    typeof hotel.enabled !== "boolean" ||
    typeof hotel.stackWithPromo !== "boolean"
  )
    return null;
  const tiers = parseLastMinuteTiers(hotel.tiers);
  if (!tiers || (hotel.enabled ? tiers.length === 0 : tiers.length > 0 || hotel.stackWithPromo))
    return null;
  if (Object.hasOwn(hotel, "promotions")) {
    const promotions = parseBookingPromotions(hotel.promotions);
    if (!promotions || promotions.some((p) => p.active)) return null; // Generalized promotions require their own evaluator.
  }
  if (
    !(await client.query("SELECT name FROM pg_timezone_names WHERE name=$1", [row.timezone]))
      .rowCount
  )
    return null;
  for (const room of roomTypeIds)
    if (!(await lockPmsPricingRoomScope(client, propertyId, room))) return null;
  const heads = (
    await client.query(
      `SELECT h.room_type_id,h.revision,r.policy FROM booking.room_last_minute_heads h
    JOIN booking.room_last_minute_revisions r USING(property_id,room_type_id,revision)
    WHERE h.property_id=$1 ORDER BY h.room_type_id FOR SHARE OF h,r`,
      [propertyId],
    )
  ).rows;
  const policies = new Map<string, NonNullable<ReturnType<typeof parseRoomLastMinutePolicy>>>();
  for (const h of heads) {
    const policy = parseRoomLastMinutePolicy(h.policy);
    if (!policy) return null;
    policies.set(h.room_type_id, policy);
  }
  const bookingLocalDate = (
    await client.query("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS date", [
      row.timezone,
    ])
  ).rows[0].date as string;
  const daysBeforeArrival = (Date.parse(checkIn) - Date.parse(bookingLocalDate)) / 86400000;
  if (daysBeforeArrival < 0) return null;
  const rooms = roomTypeIds.map((roomTypeId) => {
    const policy = policies.get(roomTypeId),
      effective = policy?.tiers.length ? policy.tiers : tiers;
    const match =
      hotel.enabled && policy?.enabled !== false
        ? effective.find(
            (t) =>
              daysBeforeArrival >= t.daysBeforeMin &&
              (t.daysBeforeMax === null || daysBeforeArrival <= t.daysBeforeMax),
          )
        : undefined;
    const bps = match ? lastMinuteBasisPoints(match.discountPercent) : 0;
    return {
      roomTypeId,
      lastMinute: bps ? { kind: "percentage" as const, basisPoints: bps } : null,
    };
  });
  const sourceRevision =
    "booking.last-minute.v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({ propertyId, hotel, timezone: row.timezone, bookingLocalDate, heads }),
      )
      .digest("hex");
  return {
    rooms,
    stacking: hotel.stackWithPromo,
    bookingLocalDate,
    propertyTimeZone: row.timezone as string,
    daysBeforeArrival,
    sourceRevision,
  };
}
