import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";

type Current = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
/** Internal pay-at-property staging after stagePricingBookingDraft, on the same
 * retained READ COMMITTED transaction. Reserves inventory and stages lifecycle,
 * event and summary together. Caller must still stage revenue/outbox/acceptance/
 * receipt, run the final quote/Finance gate, and roll back ALL writes on failure.
 * Completed acceptance replay belongs before this helper; never reset a deadline. */
export async function stagePricingBookingLifecycle(
  client: PoolClient,
  slug: unknown,
  current: Current,
  bookingId: string,
) {
  const fail = (): never => {
    throw new Error("Pricing booking lifecycle is unavailable");
  };
  const scope = await lockPublicPricingAuthority(client, slug);
  const quote = current.quote,
    mode = quote.acceptanceMode;
  const scale = pricingCurrencyScale(quote.stay.currency);
  if (
    !scope ||
    !isDeepStrictEqual(scope, current.scope) ||
    current.kind !== "current_quote_price" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId) ||
    scope.propertyId !== quote.stay.propertyId ||
    scale === null ||
    quote.paymentMethod !== "pay_at_property" ||
    (mode !== "instant" && mode !== "request") ||
    quote.evidence.dueNowMinor !== "0" ||
    quote.evidence.dueLaterMinor !== quote.evidence.totalMinor
  )
    return fail();
  const booking = (
    await client.query(
      `SELECT lifecycle_status,payment_status,source_system,booking_channel,direct_booking_source,
      expected_payment_method,edit_revision,check_in::text,check_out::text,currency,room_count,adults,children,
      total_amount::text,balance_amount::text,booking_metadata
    FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [bookingId, scope.propertyId],
    )
  ).rows[0];
  const metadata = booking?.booking_metadata;
  if (
    !booking ||
    booking.lifecycle_status !== "draft" ||
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
    metadata.acceptanceMode !== mode ||
    metadata.paymentMethod !== quote.paymentMethod ||
    !isDeepStrictEqual(metadata.pricingSelections, quote.stay.rooms) ||
    typeof metadata.requestFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.requestFingerprint) ||
    Object.hasOwn(metadata, "hostResponseDeadlineAt") ||
    Object.hasOwn(metadata, "inventoryReservation")
  )
    return fail();
  const reserved = await reserveRevalidatedQuoteInventory(client, slug, current);
  if (!isDeepStrictEqual(reserved.quote, quote)) return fail();
  if (!isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)) return fail();
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail();
  const occurredAt = now.toISOString();
  if (occurredAt < quote.evidence.issuedAt || occurredAt >= quote.evidence.expiresAt) return fail();
  const lifecycleStatus = mode === "instant" ? "confirmed" : "pending_payment";
  const hostResponseDeadlineAt =
    mode === "request" ? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
  const result = await client.query(
    `WITH changed AS (
      UPDATE booking.guest_bookings SET lifecycle_status=$3,updated_at=$4::timestamptz,
        booking_metadata=booking_metadata || $5::jsonb
      WHERE id=$1 AND property_id=$2 AND lifecycle_status='draft' AND payment_status='unpaid' AND edit_revision=0
      RETURNING *
    ), event AS (
      INSERT INTO booking.booking_status_events
        (guest_booking_id,event_type,from_status,to_status,actor_type,public_visible,public_message,event_payload,occurred_at)
      SELECT id,'guest_booking.created','draft',lifecycle_status,'guest',true,$6,$7::jsonb,$4::timestamptz FROM changed RETURNING id
    ), summary AS (
      INSERT INTO booking.direct_booking_summary_read_model
        (guest_booking_id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out,
        guest_counts,room_summary,amount_summary,public_policy,source_freshness,projected_at)
      SELECT id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out,
        jsonb_build_object('adults',adults,'children',children),jsonb_build_object('roomCount',room_count),
        jsonb_build_object('totalAmount',total_amount::text,'balanceAmount',balance_amount::text,'currency',currency),
        jsonb_build_object('acceptanceMode',$8::text),
        jsonb_build_object('pricing_quote',jsonb_build_object('status','fresh','snapshotAt',$4::timestamptz)),$4::timestamptz
      FROM changed RETURNING guest_booking_id
    ) SELECT (SELECT count(*)::int FROM changed) AS bookings,
      (SELECT count(*)::int FROM event) AS events,(SELECT count(*)::int FROM summary) AS summaries`,
    [
      bookingId,
      scope.propertyId,
      lifecycleStatus,
      occurredAt,
      {
        inventoryReservation: reserved.bundle,
        ...(hostResponseDeadlineAt ? { hostResponseDeadlineAt } : {}),
      },
      mode === "instant" ? "Your booking is confirmed." : "We have received your booking request.",
      { pricingQuoteId: quote.quoteId, requestFingerprint: metadata.requestFingerprint },
      mode,
    ],
  );
  if (
    !isDeepStrictEqual(result.rows[0], { bookings: 1, events: 1, summaries: 1 }) ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)
  )
    return fail();
  return {
    bookingId,
    lifecycleStatus,
    hostResponseDeadlineAt,
    occurredAt,
    inventoryReservation: reserved.bundle,
  };
}
