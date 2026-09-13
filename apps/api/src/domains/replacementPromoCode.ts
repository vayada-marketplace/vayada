import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isMinorAmount, pricingCurrencyScale, pricingDate } from "@vayada/domain-pms";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Booking owner port, inside an already authorized READ COMMITTED property transaction.
 * bookingAmountMinor must be the owner's minimum-booking-value basis, never posted totals.
 * This reads requested-code eligibility only; it neither reserves usage nor establishes
 * last-minute/other promotions, extras, final quote authority or permission to book. */
export async function lockReplacementPromoCode(
  client: PoolClient,
  input: {
    propertyId: string;
    currency: string;
    code: string;
    checkIn: string;
    rooms: readonly { selectionId: string; roomTypeId: string }[];
    bookingAmountMinor: string;
  },
) {
  if (
    !input ||
    !uuid(input.propertyId) ||
    !pricingDate(input.checkIn) ||
    !isMinorAmount(input.bookingAmountMinor) ||
    typeof input.code !== "string" ||
    !input.code.length ||
    input.code.length > 200 ||
    input.code !== input.code.trim() ||
    !Array.isArray(input.rooms) ||
    !input.rooms.length ||
    input.rooms.length > 99 ||
    input.rooms.some(
      (r) =>
        !r ||
        !uuid(r.roomTypeId) ||
        typeof r.selectionId !== "string" ||
        !r.selectionId.length ||
        r.selectionId.length > 200 ||
        r.selectionId !== r.selectionId.trim(),
    ) ||
    new Set(input.rooms.map((r) => r.selectionId)).size !== input.rooms.length
  )
    return null;
  const request = structuredClone(input),
    propertyId = request.propertyId.toLowerCase();
  await lockPmsInventoryMutationScope(client, propertyId);
  // Block FK-backed code insertion/retargeting as well as locking every existing code below.
  if (
    !(
      await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
        propertyId,
      ])
    ).rowCount
  )
    return null;
  const settings = (
    await client.query(
      `SELECT s.default_currency,l.timezone FROM booking.booking_settings s
    JOIN hotel_catalog.property_locations l USING(property_id) WHERE s.property_id=$1 FOR SHARE OF s,l`,
      [propertyId],
    )
  ).rows[0];
  if (!settings || settings.default_currency !== request.currency) return null;
  const scale = pricingCurrencyScale(request.currency);
  if (
    scale === null ||
    !(await client.query("SELECT name FROM pg_timezone_names WHERE name=$1", [settings.timezone]))
      .rowCount
  )
    return null;
  for (const room of request.rooms)
    if (!(await lockPmsPricingRoomScope(client, propertyId, room.roomTypeId.toLowerCase())))
      return null;
  const rows = (
    await client.query(
      `SELECT p.*,discount_value::text AS discount, min_booking_value::text AS minimum,
    valid_from::text AS booking_from,valid_until::text AS booking_until,
    stay_date_from::text AS arrival_from,stay_date_until::text AS arrival_until,
    (to_jsonb(p)-'created_at'-'updated_at')::text AS source
    FROM booking.promo_definitions p WHERE property_id=$1 ORDER BY id FOR UPDATE`,
      [propertyId],
    )
  ).rows;
  const bookingLocalDate = (
    await client.query("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS date", [
      settings.timezone,
    ])
  ).rows[0].date as string;
  const matches = rows.filter(
    (r) => r.code === request.code.toUpperCase() && r.status === "active",
  );
  if (matches.length !== 1) return null;
  const policy = matches[0];
  if (
    !policy.is_active ||
    policy.current_uses >= policy.max_uses ||
    (policy.booking_from && bookingLocalDate < policy.booking_from) ||
    (policy.booking_until && bookingLocalDate > policy.booking_until) ||
    (policy.arrival_from && request.checkIn < policy.arrival_from) ||
    (policy.arrival_until && request.checkIn > policy.arrival_until)
  )
    return null;
  const minimum = policy.minimum === null ? "0" : pricingDecimalMinor(policy.minimum, scale);
  if (minimum === null || BigInt(request.bookingAmountMinor) < BigInt(minimum)) return null;
  const eligibleSelectionIds = request.rooms
    .filter(
      (r) =>
        policy.applicable_room_ids === null ||
        policy.applicable_room_ids.includes(r.roomTypeId.toLowerCase()),
    )
    .map((r) => r.selectionId);
  if (!eligibleSelectionIds.length) return null;
  const amount = pricingDecimalMinor(
    policy.discount,
    policy.discount_type === "percentage" ? 2 : scale,
  );
  if (
    amount === null ||
    amount === "0" ||
    (policy.discount_type === "percentage" && BigInt(amount) > 10000n)
  )
    return null;
  const discount =
    policy.discount_type === "percentage"
      ? { kind: "percentage" as const, basisPoints: Number(amount) }
      : { kind: "fixed" as const, amountMinor: amount };
  const sourceRevision =
    "booking.promo-code.v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          propertyId,
          currency: request.currency,
          timezone: settings.timezone,
          bookingLocalDate,
          rows: rows.map((r) => r.source),
        }),
      )
      .digest("hex");
  return {
    id: policy.id as string,
    code: policy.code as string,
    discount,
    eligibleSelectionIds,
    minimumBookingMinor: minimum,
    bookingLocalDate,
    sourceRevision,
  };
}
