import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { isManualPricingPaymentMethod } from "@vayada/domain-booking";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import type { PmsBookingLifecycleCommand } from "../routes/pmsOperations.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { pricingExpectedPaymentMethod } from "./pricingManualPayment.js";
import { stageAcceptedPricingReservationJob } from "./pricingPmsAcceptedReservationJob.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";

/** The PMS command client: query only, row count included. */
type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

const iso = (v: unknown) =>
  v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v;

/** The hotel confirms that a pricing-v2 bank transfer or PayPal payment arrived (PMS mark-paid,
 * VAY-2139). The caller holds the transaction. Before the payment deadline only, the booking is
 * confirmed and paid from its stored acceptance: Finance's manual payment row (`recordPayment`),
 * room-night revenue from the accepted quote, the guest's confirmation and the hotel's new-booking
 * emails, and the accepted-pricing PMS job. The rooms were held when the guest booked, so
 * inventory does not change. Confirming the payment is the hotel's acceptance, in either mode. */
export async function confirmPricingManualPayment(
  client: Queryable,
  command: PmsBookingLifecycleCommand,
  confirmedAt: string,
  recordPayment: (paymentMethod: "bank_transfer" | "paypal") => Promise<void>,
): Promise<"confirmed" | "not_pending" | "deadline_passed"> {
  const row = (
    await client.query(
      `SELECT a.*,b.lifecycle_status,b.payment_status,b.expected_payment_method,
        b.total_amount::text,b.balance_amount::text,b.booking_metadata,q.payload AS quote_record
      FROM booking.pricing_quote_acceptances a
      JOIN booking.guest_bookings b ON b.id=a.guest_booking_id AND b.property_id=a.property_id
      JOIN booking.pricing_quotes q ON q.id=a.pricing_quote_id AND q.property_id=a.property_id
        AND q.organization_id=a.organization_id
      WHERE a.guest_booking_id=$1 AND a.property_id=$2 FOR UPDATE OF b`,
      [command.guestBookingId, command.propertyId],
    )
  ).rows[0];
  const history =
    row &&
    decodePricingAcceptanceHistory(
      {
        ...row,
        accepted_at: iso(row.accepted_at),
        finance_terms_captured_at: iso(row.finance_terms_captured_at),
      },
      command.propertyId,
      row.organization_id,
    );
  const quote = history?.quote;
  const metadata = row?.booking_metadata;
  if (
    !history ||
    !quote ||
    !isManualPricingPaymentMethod(quote.paymentMethod) ||
    row.lifecycle_status !== "pending_payment" ||
    row.payment_status !== "unpaid" ||
    row.expected_payment_method !== pricingExpectedPaymentMethod(quote.paymentMethod) ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId ||
    metadata.paymentMethod !== quote.paymentMethod
  )
    return "not_pending";
  const deadline = Date.parse(metadata.pendingExpiresAt ?? "");
  if (!Number.isFinite(deadline) || Date.parse(confirmedAt) >= deadline) return "deadline_passed";
  // Everything the confirmation needs is checked before the payment is recorded.
  const fail = (): never => {
    throw new Error("Pricing manual payment confirmation is unavailable");
  };
  const scale = pricingCurrencyScale(quote.stay.currency);
  const record = decodeCurrentPricingQuoteRecord(
    row.quote_record,
    command.propertyId,
    quote.quoteId,
  );
  const projection =
    record && pricingRoomRevenueProjection(quote, record.calculation.charges as never);
  if (
    scale === null ||
    !projection ||
    pricingDecimalMinor(row.total_amount, scale) !== quote.evidence.totalMinor ||
    pricingDecimalMinor(row.balance_amount, scale) !== quote.evidence.totalMinor
  )
    return fail();
  const prior = await client.query(
    "SELECT 1 FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 LIMIT 1",
    [command.guestBookingId],
  );
  if (prior.rowCount) return fail();
  await recordPayment(quote.paymentMethod);
  const user = command.audit.actor.kind === "user" ? command.audit.actor.userId : null;
  const confirmed = (
    await client.query(
      `WITH changed AS (
        UPDATE booking.guest_bookings SET lifecycle_status='confirmed',payment_status='paid',
          balance_amount=0,updated_at=$3::timestamptz
        WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status='unpaid'
        RETURNING id
      ), events AS (
        INSERT INTO booking.booking_status_events
          (guest_booking_id,event_type,from_status,to_status,actor_type,actor_user_id,public_visible,
            public_message,event_payload,occurred_at)
        SELECT id,event.type,'pending_payment','confirmed',$4,$5::uuid,true,event.message,$6::jsonb,
          $3::timestamptz
        FROM changed CROSS JOIN (VALUES
          ('guest_booking.payment_received','Payment received. Booking confirmed.'),
          ('guest_booking.accepted','Booking accepted.')) AS event(type,message)
        RETURNING id
      ), summary AS (
        UPDATE booking.direct_booking_summary_read_model SET lifecycle_status='confirmed',
          payment_status='paid',
          amount_summary=jsonb_set(amount_summary,'{balanceAmount}','0'::jsonb),
          projected_at=$3::timestamptz
        WHERE guest_booking_id IN (SELECT id FROM changed) RETURNING guest_booking_id
      ) SELECT (SELECT count(*)::int FROM changed) AS bookings,(SELECT count(*)::int FROM events) AS events,
        (SELECT count(*)::int FROM summary) AS summaries`,
      [
        command.guestBookingId,
        command.propertyId,
        confirmedAt,
        user ? "property_user" : "system",
        user,
        {
          commandId: command.commandId,
          requestId: command.audit.requestId,
          correlationId: command.audit.correlationId ?? command.audit.requestId,
          acceptanceId: history.id,
          paymentMethod: quote.paymentMethod,
          fromPaymentStatus: "unpaid",
          toPaymentStatus: "paid",
        },
      ],
    )
  ).rows[0];
  if (confirmed?.bookings !== 1 || confirmed.events !== 2 || confirmed.summaries !== 1)
    return fail();
  await persistDirectNightlyRevenueProjection(
    client,
    { guestBookingId: command.guestBookingId, propertyId: command.propertyId },
    projection,
  );
  await enqueueBookingTransitionNotifications(client, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    occurredAt: confirmedAt,
    correlationId: command.audit.correlationId ?? command.audit.requestId,
    causationId: command.commandId,
    actor: user ? { type: "user", userId: user } : { type: "system" },
    source: "apps/api-pricing-manual-payment",
    transition: {
      eventType: "guest_booking.payment_received",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
      revision: history.id,
    },
  });
  await stageAcceptedPricingReservationJob(
    client as unknown as PoolClient,
    { propertyId: command.propertyId, organizationId: row.organization_id },
    { acceptanceId: history.id, bookingId: history.bookingId, acceptedAt: history.acceptedAt },
  );
  return "confirmed";
}
