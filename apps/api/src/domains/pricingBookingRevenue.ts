import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import type { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";

type Current = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
type Lifecycle = Awaited<ReturnType<typeof stagePricingBookingLifecycle>>;
/** Initial instant/pay-at-property revenue only, after lifecycle staging on the
 * SAME retained READ COMMITTED transaction. Owner results are never public input.
 * Existing evidence is a conflict: completed acceptance replay belongs upstream.
 * Caller must finish acceptance/outbox/receipt and final quote/Finance gate, and
 * roll back ALL writes on failure. This helper never commits or reprices history. */
export async function stagePricingBookingRevenue(
  client: PoolClient,
  slug: unknown,
  current: Current,
  lifecycle: Lifecycle,
) {
  const fail = (): never => {
    throw new Error("Pricing booking revenue is unavailable");
  };
  const scope = await lockPublicPricingAuthority(client, slug);
  const quote = current.quote;
  const projection = pricingRoomRevenueProjection(quote, current.calculation?.charges);
  const scale = pricingCurrencyScale(quote.stay.currency);
  if (
    !scope ||
    !isDeepStrictEqual(scope, current.scope) ||
    current.kind !== "current_quote_price" ||
    scope.propertyId !== quote.stay.propertyId ||
    !projection ||
    scale === null ||
    quote.acceptanceMode !== "instant" ||
    quote.paymentMethod !== "pay_at_property" ||
    quote.evidence.dueNowMinor !== "0" ||
    quote.evidence.dueLaterMinor !== quote.evidence.totalMinor ||
    lifecycle.lifecycleStatus !== "confirmed" ||
    lifecycle.hostResponseDeadlineAt !== null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lifecycle.bookingId)
  )
    return fail();
  // Separate statement: refresh the evidence snapshot after waiting for the lock.
  const booking = (
    await client.query(
      `SELECT lifecycle_status,payment_status,source_system,booking_channel,direct_booking_source,
    expected_payment_method,edit_revision,check_in::text,check_out::text,currency,room_count,
    adults,children,total_amount::text,balance_amount::text,booking_metadata
    FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [lifecycle.bookingId, scope.propertyId],
    )
  ).rows[0];
  const metadata = booking?.booking_metadata;
  if (
    !booking ||
    booking.lifecycle_status !== "confirmed" ||
    booking.payment_status !== "unpaid" ||
    booking.source_system !== "booking" ||
    booking.booking_channel !== "direct" ||
    booking.direct_booking_source !== "booking_engine" ||
    booking.expected_payment_method !== "pay_at_property" ||
    booking.edit_revision !== 0 ||
    booking.check_in !== quote.stay.checkIn ||
    booking.check_out !== quote.stay.checkOut ||
    booking.currency !== quote.stay.currency ||
    booking.room_count !== quote.stay.rooms.length ||
    booking.adults !== quote.stay.rooms.reduce((n, r) => n + r.guests.adults, 0) ||
    booking.children !==
      quote.stay.rooms.reduce((n, r) => n + r.guests.childAgesAtCheckIn.length, 0) ||
    pricingDecimalMinor(booking.total_amount, scale) !== quote.evidence.totalMinor ||
    pricingDecimalMinor(booking.balance_amount, scale) !== quote.evidence.totalMinor ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId ||
    metadata.acceptanceMode !== "instant" ||
    metadata.paymentMethod !== quote.paymentMethod ||
    !isDeepStrictEqual(metadata.pricingSelections, quote.stay.rooms) ||
    !isDeepStrictEqual(metadata.inventoryReservation, lifecycle.inventoryReservation) ||
    Object.hasOwn(metadata, "hostResponseDeadlineAt") ||
    typeof metadata.requestFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.requestFingerprint)
  )
    return fail();
  const prior = await client.query(
    "SELECT id FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 LIMIT 1",
    [lifecycle.bookingId],
  );
  if (prior.rows.length) return fail();
  await persistDirectNightlyRevenueProjection(
    client,
    { guestBookingId: lifecycle.bookingId, propertyId: scope.propertyId },
    projection,
  );
  const rows = (
    await client.query(
      `SELECT room_type_id::text,stay_date::text,recognized_on::text,currency,gross_room_amount::text,
    occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,
    source_revision::text,line_position,corrects_evidence_id,command_key
    FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 AND property_id=$2
    ORDER BY line_position,stay_date`,
      [lifecycle.bookingId, scope.propertyId],
    )
  ).rows;
  const hash = createHash("sha256").update(projection.fingerprint).digest("hex");
  if (
    rows.length !== projection.nights.length ||
    rows.some((row, i) => {
      const night = projection.nights[i];
      return (
        row.room_type_id !== night.roomTypeId ||
        row.stay_date !== night.stayDate ||
        row.recognized_on !== night.stayDate ||
        row.currency !== quote.stay.currency ||
        pricingDecimalMinor(row.gross_room_amount, scale) !==
          pricingDecimalMinor(night.grossRoomAmount, scale) ||
        row.occupied_room_nights !== 1 ||
        row.economic_event !== "room_night" ||
        row.lifecycle_state !== "confirmed" ||
        row.source_kind !== "direct" ||
        row.evidence_quality !== "exact" ||
        row.source_revision !== "1" ||
        row.line_position !== night.roomPositions![0] ||
        row.corrects_evidence_id !== null ||
        row.command_key !==
          `direct:${hash}:${night.stayDate}:${night.roomPositions![0]}:${night.roomTypeId}`
      );
    })
  )
    return fail();
  if (!isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)) return fail();
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    now.toISOString() < quote.evidence.issuedAt ||
    now.toISOString() >= quote.evidence.expiresAt
  )
    return fail();
  return { bookingId: lifecycle.bookingId, roomNights: rows.length };
}
