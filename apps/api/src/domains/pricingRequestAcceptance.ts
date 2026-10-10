import { createHash } from "node:crypto";
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
import { confirmCapturedPricingCardRequest } from "./pricingCardPaymentCompletion.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { stripeAmountMinor } from "./stripeMoney.js";

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
 * asked, so inventory does not change. Anything but an open request is "not_pending".
 * A card request is captured on the hotel's connected account first, then confirmed. */
export async function acceptPricingRequest(
  client: Queryable,
  command: PmsBookingLifecycleCommand,
  acceptedAt: string,
  provider?: StripeBookingPaymentProvider,
): Promise<"accepted" | "not_pending" | "deadline_passed" | "capture_failed"> {
  const row = (
    await client.query(
      `SELECT a.*,b.lifecycle_status,b.payment_status,b.expected_payment_method,
        b.total_amount::text,b.balance_amount::text,b.booking_metadata,b.public_reference,
        q.payload AS quote_record,p.status AS card_status,p.provider_payment_intent_id AS card_intent,
        p.amount::text AS card_amount,p.currency AS card_currency,acct.provider_account_id AS card_account
      FROM booking.pricing_quote_acceptances a
      JOIN booking.guest_bookings b ON b.id=a.guest_booking_id AND b.property_id=a.property_id
      JOIN booking.pricing_quotes q ON q.id=a.pricing_quote_id AND q.property_id=a.property_id
        AND q.organization_id=a.organization_id
      LEFT JOIN finance.payments p ON p.id=b.active_card_payment_id AND p.property_id=b.property_id
      LEFT JOIN finance.payment_provider_accounts acct ON acct.id=p.provider_account_id
        AND acct.property_id=p.property_id
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
  const card = quote?.paymentMethod === "card";
  if (
    !history ||
    !quote ||
    quote.acceptanceMode !== "request" ||
    row.lifecycle_status !== "pending_payment" ||
    (card
      ? row.payment_status !== "authorized" ||
        row.card_status !== "authorized" ||
        row.expected_payment_method !== "unknown" ||
        typeof row.card_intent !== "string" ||
        typeof row.card_account !== "string"
      : quote.paymentMethod !== "pay_at_property" ||
        row.payment_status !== "unpaid" ||
        row.expected_payment_method !== "pay_at_property") ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId
  )
    return "not_pending";
  const deadline = Date.parse(metadata.hostResponseDeadlineAt ?? "");
  if (!Number.isFinite(deadline) || Date.parse(acceptedAt) >= deadline) return "deadline_passed";
  // Everything the confirmation needs is checked before any money moves.
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
  if (card) {
    if (!provider) return "capture_failed";
    // Lock the payment before calling Stripe: a lock race can then only fail before a capture.
    const payment = await client.query(
      "SELECT 1 FROM finance.payments WHERE provider_payment_intent_id=$1 AND property_id=$2 AND status='authorized' FOR UPDATE",
      [row.card_intent, command.propertyId],
    );
    if (payment.rows.length !== 1) return "not_pending";
    // The hold must be this booking's own, for its exact amount, before anything is captured.
    const bound = (
      intent: Awaited<ReturnType<StripeBookingPaymentProvider["retrievePaymentIntent"]>>,
    ) =>
      intent.paymentIntentId === row.card_intent &&
      intent.propertyId === command.propertyId &&
      intent.bookingReference === row.public_reference &&
      intent.amountMinor === stripeAmountMinor(row.card_amount, row.card_currency) &&
      intent.currency.toUpperCase() === String(row.card_currency).toUpperCase();
    let intent = await provider.retrievePaymentIntent(row.card_intent, row.card_account);
    if (!bound(intent)) return "capture_failed";
    if (intent.status === "requires_capture") {
      intent = await provider.capturePaymentIntent(
        row.card_intent,
        row.card_account,
        // Per command: Stripe replays a key's first answer, failures included, for 24 hours.
        `pricing-card-request-capture:${command.propertyId}:${command.guestBookingId}:${createHash("sha256").update(command.idempotencyKey).digest("hex")}`,
      );
      if (!bound(intent)) return "capture_failed";
    }
    if (intent.status !== "succeeded") return "capture_failed";
    await confirmCapturedPricingCardRequest(
      client as unknown as PoolClient,
      command.propertyId,
      command.guestBookingId,
      {
        paymentIntentId: intent.paymentIntentId,
        status: intent.status,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        metadata: { propertyId: intent.propertyId, bookingReference: intent.bookingReference },
      },
      user,
    );
    return "accepted";
  }
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
