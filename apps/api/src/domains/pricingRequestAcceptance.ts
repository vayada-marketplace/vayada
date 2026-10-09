import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import type { PmsBookingLifecycleCommand } from "../routes/pmsOperations.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
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

/** The hotel accepts a pricing-v2 pay-at-property request (PMS accept command). The caller
 * holds the booking row lock and owns the transaction. Everything comes from the stored
 * acceptance, never the hotel's current prices: room-night revenue from the accepted quote,
 * the guest's acceptance email and the PMS reservation job. The rooms were held when the guest
 * asked, so inventory does not change. Anything but an open request is "not_pending". */
export async function acceptPricingRequest(
  client: Queryable,
  command: PmsBookingLifecycleCommand,
  acceptedAt: string,
): Promise<"accepted" | "not_pending" | "deadline_passed"> {
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
    quote.acceptanceMode !== "request" ||
    quote.paymentMethod !== "pay_at_property" ||
    row.lifecycle_status !== "pending_payment" ||
    row.payment_status !== "unpaid" ||
    row.expected_payment_method !== "pay_at_property" ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId
  )
    return "not_pending";
  const deadline = Date.parse(metadata.hostResponseDeadlineAt ?? "");
  if (!Number.isFinite(deadline) || Date.parse(acceptedAt) >= deadline) return "deadline_passed";
  const fail = (): never => {
    throw new Error("Pricing request acceptance is unavailable");
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
  const user = command.audit.actor.kind === "user" ? command.audit.actor.userId : null;
  const confirmed = (
    await client.query(
      `WITH changed AS (
        UPDATE booking.guest_bookings SET lifecycle_status='confirmed',updated_at=$3::timestamptz
        WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status='unpaid'
        RETURNING id
      ), event AS (
        INSERT INTO booking.booking_status_events
          (guest_booking_id,event_type,from_status,to_status,actor_type,actor_user_id,public_visible,
            public_message,event_payload,occurred_at)
        SELECT id,'guest_booking.accepted','pending_payment','confirmed',$4,$5::uuid,true,
          'Booking request accepted.',$6::jsonb,$3::timestamptz FROM changed RETURNING id
      ), summary AS (
        UPDATE booking.direct_booking_summary_read_model SET lifecycle_status='confirmed',
          projected_at=$3::timestamptz
        WHERE guest_booking_id IN (SELECT id FROM changed) RETURNING guest_booking_id
      ) SELECT (SELECT count(*)::int FROM changed) AS bookings,(SELECT count(*)::int FROM event) AS events,
        (SELECT count(*)::int FROM summary) AS summaries`,
      [
        command.guestBookingId,
        command.propertyId,
        acceptedAt,
        user ? "property_user" : "system",
        user,
        {
          commandId: command.commandId,
          requestId: command.audit.requestId,
          correlationId: command.audit.correlationId ?? command.audit.requestId,
          acceptanceId: history.id,
          paymentMethod: "pay_at_property",
        },
      ],
    )
  ).rows[0];
  if (confirmed?.bookings !== 1 || confirmed.events !== 1 || confirmed.summaries !== 1)
    return fail();
  const prior = await client.query(
    "SELECT 1 FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 LIMIT 1",
    [command.guestBookingId],
  );
  if (prior.rowCount) return fail();
  await persistDirectNightlyRevenueProjection(
    client,
    { guestBookingId: command.guestBookingId, propertyId: command.propertyId },
    projection,
  );
  await enqueueBookingTransitionNotifications(client, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    occurredAt: acceptedAt,
    correlationId: command.audit.correlationId ?? command.audit.requestId,
    causationId: command.commandId,
    actor: user ? { type: "user", userId: user } : { type: "system" },
    source: "apps/api-replacement-booking-request-acceptance",
    transition: {
      eventType: "guest_booking.accepted",
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
  return "accepted";
}
