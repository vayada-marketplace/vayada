import { createHash } from "node:crypto";
import type pg from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { pricingCardQuoteSupported } from "./pricingCardPayment.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { stageAcceptedPricingReservationJob } from "./pricingPmsAcceptedReservationJob.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";
import { stripeAmountMinor } from "./stripeMoney.js";

export class PricingCardPaymentError extends Error {
  constructor(
    readonly code: "unavailable" | "pending" | "conflict",
    message = "Card payment is not complete",
  ) {
    super(message);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown) =>
  v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : v;

const CARD_ROW_SELECT = `SELECT a.*,b.lifecycle_status,b.payment_status,b.expected_payment_method,
    b.public_reference,b.currency,b.total_amount::text,b.balance_amount::text,b.booking_metadata,
    p.id AS payment_id,p.status AS payment_row_status,p.amount::text AS payment_amount,
    p.currency AS payment_currency,p.provider_payment_intent_id,acct.provider_account_id AS account_ref,
    q.payload AS quote_record
  FROM booking.pricing_quote_acceptances a
  JOIN booking.guest_bookings b ON b.id=a.guest_booking_id AND b.property_id=a.property_id
  LEFT JOIN finance.payments p ON p.id=b.active_card_payment_id AND p.property_id=b.property_id
  LEFT JOIN finance.payment_provider_accounts acct ON acct.id=p.provider_account_id
    AND acct.property_id=p.property_id
  JOIN booking.pricing_quotes q ON q.id=a.pricing_quote_id AND q.property_id=a.property_id
    AND q.organization_id=a.organization_id`;

type Queryable = Pick<pg.PoolClient, "query">;
type CardRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type PaymentEvidence = {
  paymentIntentId: string;
  status: string;
  amountMinor: number;
  currency: string;
  /** Stripe metadata; checked when the caller retrieved the intent itself. */
  metadata?: { propertyId: string | null; bookingReference: string | null };
};

function decodeCardRow(row: CardRow | undefined, propertyId: string) {
  if (!row) throw new PricingCardPaymentError("unavailable");
  const history = decodePricingAcceptanceHistory(
    {
      ...row,
      accepted_at: iso(row.accepted_at),
      finance_terms_captured_at: iso(row.finance_terms_captured_at),
    },
    propertyId,
    row.organization_id,
  );
  const quote = history?.quote;
  if (
    !history ||
    !quote ||
    !pricingCardQuoteSupported(quote) ||
    row.expected_payment_method !== "unknown" ||
    row.booking_metadata?.paymentMethod !== "card"
  )
    throw new PricingCardPaymentError("unavailable");
  const done = {
    kind: "accepted" as const,
    bookingId: history.bookingId,
    acceptanceId: history.id,
    acceptedAt: history.acceptedAt,
    bookingReference: row.public_reference as string,
  };
  const paid = row.lifecycle_status === "confirmed" && row.payment_status !== "unpaid";
  // A card request the guest has authorised waits for the hotel, whose acceptance captures it.
  const authorized =
    quote.acceptanceMode === "request" &&
    row.lifecycle_status === "pending_payment" &&
    row.payment_status === "authorized" &&
    row.payment_row_status === "authorized" &&
    typeof row.provider_payment_intent_id === "string" &&
    typeof row.account_ref === "string";
  if (
    !paid &&
    !authorized &&
    (row.lifecycle_status !== "pending_payment" ||
      row.payment_status !== "unpaid" ||
      row.payment_row_status !== "requires_action" ||
      typeof row.provider_payment_intent_id !== "string" ||
      typeof row.account_ref !== "string")
  )
    throw new PricingCardPaymentError("unavailable");
  return { history, quote, done, paid, authorized };
}

/** The answer for a card request waiting for the hotel. */
function requestedResult(
  decoded: ReturnType<typeof decodeCardRow>,
  hostResponseDeadlineAt: string,
) {
  return { ...decoded.done, kind: "requested" as const, hostResponseDeadlineAt };
}

/** Stripe evidence must be this booking's own payment, for its exact amount. */
function checkCardEvidence(row: CardRow, propertyId: string, evidence: PaymentEvidence) {
  let expectedMinor: number;
  try {
    expectedMinor = stripeAmountMinor(row.payment_amount, row.payment_currency);
  } catch {
    throw new PricingCardPaymentError("conflict");
  }
  if (
    evidence.paymentIntentId !== row.provider_payment_intent_id ||
    evidence.amountMinor !== expectedMinor ||
    evidence.currency.toUpperCase() !== String(row.payment_currency).toUpperCase() ||
    (evidence.metadata &&
      (evidence.metadata.propertyId !== propertyId ||
        evidence.metadata.bookingReference !== row.public_reference))
  )
    throw new PricingCardPaymentError("conflict", "Card payment does not match the booking");
}

/** Record a card request the guest authorised (Stripe `requires_capture`). The hotel has the
 * legacy 24 hours from now to answer; the guest and the hotel get the request emails. */
async function authorizeCardRequest(
  client: Queryable,
  row: CardRow,
  propertyId: string,
  decoded: ReturnType<typeof decodeCardRow>,
  evidence: PaymentEvidence,
) {
  checkCardEvidence(row, propertyId, evidence);
  if (decoded.quote.acceptanceMode !== "request") throw new PricingCardPaymentError("conflict");
  if (evidence.status !== "requires_capture") throw new PricingCardPaymentError("pending");
  const { history } = decoded;
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  const occurredAt = now.toISOString();
  const hostResponseDeadlineAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const payment = await client.query(
    `UPDATE finance.payments SET status='authorized',authorized_at=$2::timestamptz,updated_at=$2::timestamptz,
        payment_metadata=payment_metadata || '{"providerStatus":"requires_capture","reconciliationStatus":"authorized"}'::jsonb
      WHERE id=$1 AND status='requires_action' RETURNING id`,
    [row.payment_id, occurredAt],
  );
  const counts = (
    await client.query(
      `WITH changed AS (
        UPDATE booking.guest_bookings SET payment_status='authorized',updated_at=$3::timestamptz,
          booking_metadata=booking_metadata || jsonb_build_object('hostResponseDeadlineAt',$4::text)
        WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status='unpaid'
        RETURNING id
      ), event AS (
        INSERT INTO booking.booking_status_events
          (guest_booking_id,event_type,from_status,to_status,actor_type,public_visible,public_message,event_payload,occurred_at)
        SELECT id,'guest_booking.payment_authorized','pending_payment','pending_payment','system',true,
          'Card authorised. Your booking request is waiting for the hotel.',$5::jsonb,$3::timestamptz
        FROM changed RETURNING id
      ), summary AS (
        UPDATE booking.direct_booking_summary_read_model SET payment_status='authorized',projected_at=$3::timestamptz
        WHERE guest_booking_id IN (SELECT id FROM changed) RETURNING guest_booking_id
      ) SELECT (SELECT count(*)::int FROM changed) AS bookings,(SELECT count(*)::int FROM event) AS events,
        (SELECT count(*)::int FROM summary) AS summaries`,
      [
        history.bookingId,
        propertyId,
        occurredAt,
        hostResponseDeadlineAt,
        { provider: "stripe", paymentIntentId: evidence.paymentIntentId, acceptanceId: history.id },
      ],
    )
  ).rows[0];
  if (
    payment.rowCount !== 1 ||
    counts?.bookings !== 1 ||
    counts.events !== 1 ||
    counts.summaries !== 1
  )
    throw new PricingCardPaymentError("conflict");
  await enqueueBookingTransitionNotifications(client, {
    propertyId,
    guestBookingId: history.bookingId,
    occurredAt,
    correlationId: history.command.requestId,
    causationId: evidence.paymentIntentId,
    actor: { type: "provider" },
    source: "apps/api-replacement-booking-card-request",
    transition: {
      eventType: "guest_booking.payment_authorized",
      fromStatus: "pending_payment",
      toStatus: "pending_payment",
      revision: history.id,
    },
  });
  return requestedResult(decoded, hostResponseDeadlineAt);
}

/** Confirm a locked pending card booking from verified Stripe evidence. A captured card request
 * is the hotel's acceptance (`guest_booking.accepted`, the acceptance email), by the hotel's
 * user when it accepted in the PMS. */
async function applyCardPayment(
  client: Queryable,
  row: CardRow,
  propertyId: string,
  decoded: ReturnType<typeof decodeCardRow>,
  evidence: PaymentEvidence,
  acceptedBy: string | null = null,
) {
  const { history, quote, done } = decoded;
  const request = quote.acceptanceMode === "request";
  checkCardEvidence(row, propertyId, evidence);
  if (evidence.status !== "succeeded") throw new PricingCardPaymentError("pending");
  const intent = evidence;
  const scale = pricingCurrencyScale(quote.stay.currency);
  const record = decodeCurrentPricingQuoteRecord(row.quote_record, propertyId, quote.quoteId);
  const projection =
    record && pricingRoomRevenueProjection(quote, record.calculation.charges as never);
  if (
    scale === null ||
    !projection ||
    pricingDecimalMinor(row.total_amount, scale) !== quote.evidence.totalMinor ||
    pricingDecimalMinor(row.balance_amount, scale) !== quote.evidence.totalMinor
  )
    throw new PricingCardPaymentError("conflict");
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
  const occurredAt = now.toISOString();
  const dueLater = quote.evidence.dueLaterMinor;
  const unit = 10n ** BigInt(scale);
  const balance = `${BigInt(dueLater) / unit}${scale ? "." + (BigInt(dueLater) % unit).toString().padStart(scale, "0") : ""}`;
  const paymentStatus = dueLater === "0" ? "paid" : "partially_paid";
  await client.query(
    `UPDATE finance.payments SET status='paid',paid_at=$2::timestamptz,updated_at=$2::timestamptz,
        payment_metadata=payment_metadata || '{"providerStatus":"succeeded","reconciliationStatus":"matched"}'::jsonb
      WHERE id=$1 AND status=$3`,
    [row.payment_id, occurredAt, request ? "authorized" : "requires_action"],
  );
  const confirmed = await client.query(
    `WITH changed AS (
        UPDATE booking.guest_bookings SET lifecycle_status='confirmed',payment_status=$3,
          balance_amount=$4::numeric,updated_at=$5::timestamptz
        WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status=$7
        RETURNING id
      ), event AS (
        INSERT INTO booking.booking_status_events
          (guest_booking_id,event_type,from_status,to_status,actor_type,actor_user_id,public_visible,
            public_message,event_payload,occurred_at)
        SELECT id,$8,'pending_payment','confirmed',$9,$10::uuid,true,$11,$6::jsonb,$5::timestamptz
        FROM changed RETURNING id
      ), summary AS (
        UPDATE booking.direct_booking_summary_read_model SET lifecycle_status='confirmed',payment_status=$3,
          amount_summary=jsonb_set(amount_summary,'{balanceAmount}',to_jsonb($4::text)),projected_at=$5::timestamptz
        WHERE guest_booking_id IN (SELECT id FROM changed) RETURNING guest_booking_id
      ) SELECT (SELECT count(*)::int FROM changed) AS bookings,(SELECT count(*)::int FROM event) AS events,
        (SELECT count(*)::int FROM summary) AS summaries`,
    [
      history.bookingId,
      propertyId,
      paymentStatus,
      balance,
      occurredAt,
      { provider: "stripe", paymentIntentId: intent.paymentIntentId, acceptanceId: history.id },
      request ? "authorized" : "unpaid",
      request ? "guest_booking.accepted" : "guest_booking.payment_received",
      acceptedBy ? "property_user" : "system",
      acceptedBy,
      request ? "Booking request accepted." : "Card payment received. Booking confirmed.",
    ],
  );
  const counts = confirmed.rows[0];
  if (counts?.bookings !== 1 || counts.events !== 1 || counts.summaries !== 1)
    throw new PricingCardPaymentError("conflict");
  const prior = await client.query(
    "SELECT 1 FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 LIMIT 1",
    [history.bookingId],
  );
  if (prior.rowCount) throw new PricingCardPaymentError("conflict");
  await persistDirectNightlyRevenueProjection(
    client,
    { guestBookingId: history.bookingId, propertyId },
    projection,
  );
  await enqueueBookingTransitionNotifications(client, {
    propertyId,
    guestBookingId: history.bookingId,
    occurredAt,
    correlationId: history.command.requestId,
    causationId: intent.paymentIntentId,
    actor: acceptedBy ? { type: "user", userId: acceptedBy } : { type: "provider" },
    source: "apps/api-replacement-booking-card-payment",
    transition: {
      eventType: request ? "guest_booking.accepted" : "guest_booking.payment_received",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
      revision: history.id,
    },
  });
  await stageAcceptedPricingReservationJob(
    client as pg.PoolClient,
    { propertyId, organizationId: row.organization_id },
    done,
  );
  return done;
}

async function lockCardRow(
  client: Queryable,
  propertyId: string,
  where: string,
  values: unknown[],
) {
  // Same first lock as acceptance, so completion serializes with other inventory writers.
  await lockPmsInventoryMutationScope(client as pg.PoolClient, propertyId);
  return (await client.query(`${CARD_ROW_SELECT} WHERE ${where} FOR UPDATE OF b`, values))
    .rows[0] as CardRow | undefined;
}

/** Finish an accepted card quote once Stripe reports the payment (K2 of
 * engineering/pricing-card-acceptance.md). The acceptance was stored while the quote was
 * valid, so nothing is repriced: the booking is resolved from that acceptance, not from the
 * hotel's current public state, and a guest who paid is confirmed even if public booking has
 * since been switched off. Idempotent: a paid booking answers as already completed. */
export async function completePricingCardPayment(
  pool: Pick<pg.Pool, "connect">,
  provider: StripeBookingPaymentProvider,
  input: { slug: unknown; quoteId: unknown; requestId: unknown },
) {
  const { slug, quoteId, requestId } = input;
  if (
    typeof slug !== "string" ||
    typeof quoteId !== "string" ||
    !uuid.test(quoteId) ||
    typeof requestId !== "string" ||
    !requestId.length ||
    requestId.length > 200
  )
    throw new PricingCardPaymentError("unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const property = (
      await client.query(
        `SELECT property_id FROM hotel_catalog.property_slugs
        WHERE slug=$1 AND locale IS NULL AND purpose='canonical' AND status='active'`,
        [slug],
      )
    ).rows;
    if (property.length !== 1) throw new PricingCardPaymentError("unavailable");
    const propertyId = property[0].property_id as string;
    const row = await lockCardRow(
      client,
      propertyId,
      "a.property_id=$1 AND a.pricing_quote_id=$2 AND a.key_hash=$3",
      [propertyId, quoteId, createHash("sha256").update(requestId).digest("hex")],
    );
    const decoded = decodeCardRow(row, propertyId);
    if (decoded.paid) {
      await client.query("COMMIT");
      return { ...decoded.done, replayed: true as const };
    }
    if (decoded.authorized) {
      await client.query("COMMIT");
      return {
        ...requestedResult(decoded, row!.booking_metadata.hostResponseDeadlineAt),
        replayed: true as const,
      };
    }
    const intent = await provider.retrievePaymentIntent(
      row!.provider_payment_intent_id,
      row!.account_ref,
    );
    const evidence = {
      paymentIntentId: intent.paymentIntentId,
      status: intent.status,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      metadata: { propertyId: intent.propertyId, bookingReference: intent.bookingReference },
    };
    // A request is only authorised here; the hotel's acceptance captures it.
    const done =
      decoded.quote.acceptanceMode === "request"
        ? await authorizeCardRequest(client, row!, propertyId, decoded, evidence)
        : await applyCardPayment(client, row!, propertyId, decoded, evidence);
    await client.query("COMMIT");
    return { ...done, replayed: false as const };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Property of a replacement-pricing card booking paid through this PaymentIntent, or null for
 * any other payment. Unlocked lookup so callers can take the inventory lock first. */
export async function pricingCardPaymentProperty(
  client: Queryable,
  paymentIntentId: string,
): Promise<string | null> {
  const row = (
    await client.query(
      `SELECT payment.property_id::text AS property_id FROM finance.payments payment
      JOIN booking.guest_bookings booking ON booking.id=payment.guest_booking_id
        AND booking.property_id=payment.property_id
      WHERE payment.provider_payment_intent_id=$1 AND payment.payment_method='card'
        AND booking.booking_metadata->>'targetSource'='pricing_quote_draft'
      LIMIT 1`,
      [paymentIntentId],
    )
  ).rows[0];
  return row ? row.property_id : null;
}

/** The legacy Stripe settlement entry points (webhook, confirm-authorization, expiry sweep)
 * delegate replacement-pricing card bookings here, inside their transaction, so these bookings
 * are confirmed with their acceptance, revenue and PMS job and never the legacy way. */
export async function settlePricingCardPayment(
  client: Queryable,
  propertyId: string,
  input: { paymentIntentId: string; amountMinor: number; currency?: string | null },
): Promise<"settled" | "already_settled"> {
  const row = await lockCardRow(
    client,
    propertyId,
    "a.property_id=$1 AND p.provider_payment_intent_id=$2",
    [propertyId, input.paymentIntentId],
  );
  const decoded = decodeCardRow(row, propertyId);
  if (decoded.paid) return "already_settled";
  await applyCardPayment(client, row!, propertyId, decoded, {
    paymentIntentId: input.paymentIntentId,
    status: "succeeded",
    amountMinor: input.amountMinor,
    currency: input.currency ?? row!.payment_currency,
  });
  return "settled";
}

/** The hotel accepted a card request and Stripe captured it: confirm it from its acceptance under
 * the booking row lock the PMS accept command already holds. No inventory lock: the capture's
 * webhook settles inventory lock first and must not deadlock with the accept. Idempotent. */
export async function confirmCapturedPricingCardRequest(
  client: Queryable,
  propertyId: string,
  guestBookingId: string,
  evidence: PaymentEvidence,
  acceptedBy: string | null,
) {
  const row = (
    await client.query(
      `${CARD_ROW_SELECT} WHERE a.property_id=$1 AND a.guest_booking_id=$2 FOR UPDATE OF b`,
      [propertyId, guestBookingId],
    )
  ).rows[0] as CardRow | undefined;
  const decoded = decodeCardRow(row, propertyId);
  if (decoded.paid) return decoded.done;
  if (!decoded.authorized) throw new PricingCardPaymentError("unavailable");
  return applyCardPayment(client, row!, propertyId, decoded, evidence, acceptedBy);
}

/** Record a card request Stripe reports as authorised, inside the caller's transaction (the
 * expiry sweep, when the guest left before the page confirmed it). Idempotent. */
export async function authorizePricingCardRequest(
  client: Queryable,
  propertyId: string,
  input: { paymentIntentId: string; amountMinor: number; currency: string },
): Promise<"authorized" | "already_authorized"> {
  const row = await lockCardRow(
    client,
    propertyId,
    "a.property_id=$1 AND p.provider_payment_intent_id=$2",
    [propertyId, input.paymentIntentId],
  );
  const decoded = decodeCardRow(row, propertyId);
  if (decoded.authorized || decoded.paid) return "already_authorized";
  await authorizeCardRequest(client, row!, propertyId, decoded, {
    ...input,
    status: "requires_capture",
  });
  return "authorized";
}

const CANCELABLE = ["requires_payment_method", "requires_confirmation", "requires_action"];

/** Expiry sweep for an accepted card booking past `pendingExpiresAt`. Takes the inventory lock
 * before the booking, like acceptance and payment, then cancels the PaymentIntent, or confirms
 * the booking if the payment arrived in time. A canceled payment expires the booking and
 * releases its rooms; the guest was never told the booking was confirmed, so no email. */
export async function expirePricingCardBooking(
  client: Queryable,
  provider: StripeBookingPaymentProvider,
  input: { propertyId: string; guestBookingId: string; now: Date },
  releaseRooms: (bookingMetadata: unknown) => Promise<void>,
): Promise<"settled" | "expired" | "pending" | "authorized"> {
  await lockPmsInventoryMutationScope(client as pg.PoolClient, input.propertyId);
  const row = (
    await client.query(
      `SELECT b.lifecycle_status,b.payment_status,b.public_reference,b.booking_metadata,
        p.id AS payment_id,p.provider_payment_intent_id AS intent,acct.provider_account_id AS account_ref
      FROM booking.guest_bookings b
      JOIN finance.payments p ON p.id=b.active_card_payment_id AND p.property_id=b.property_id
      JOIN finance.payment_provider_accounts acct ON acct.id=p.provider_account_id
        AND acct.property_id=p.property_id
      WHERE b.id=$1 AND b.property_id=$2 AND b.booking_metadata->>'targetSource'='pricing_quote_draft'
      FOR UPDATE OF b,p`,
      [input.guestBookingId, input.propertyId],
    )
  ).rows[0];
  const deadline = Date.parse(row?.booking_metadata?.pendingExpiresAt ?? "");
  if (
    !row ||
    row.lifecycle_status !== "pending_payment" ||
    row.payment_status !== "unpaid" ||
    !Number.isFinite(deadline) ||
    deadline > input.now.getTime() ||
    typeof row.intent !== "string" ||
    typeof row.account_ref !== "string"
  )
    return "pending";
  const check = (
    intent: Awaited<ReturnType<StripeBookingPaymentProvider["retrievePaymentIntent"]>>,
  ) => {
    if (
      intent.paymentIntentId !== row.intent ||
      intent.propertyId !== input.propertyId ||
      intent.bookingReference !== row.public_reference
    )
      throw new PricingCardPaymentError("conflict", "Card payment does not match the booking");
    return intent;
  };
  const settle = async (intent: { amountMinor: number; currency: string }) => {
    await settlePricingCardPayment(client, input.propertyId, {
      paymentIntentId: row.intent,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
    });
    return "settled" as const;
  };
  let intent = check(await provider.retrievePaymentIntent(row.intent, row.account_ref));
  if (intent.status === "succeeded") return settle(intent);
  // A guest who authorised a card request and left before the page confirmed it: the request
  // now waits for the hotel instead of expiring.
  if (intent.status === "requires_capture") {
    await authorizePricingCardRequest(client, input.propertyId, {
      paymentIntentId: row.intent,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
    });
    return "authorized";
  }
  if (CANCELABLE.includes(intent.status)) {
    try {
      intent = check(
        await provider.cancelPaymentIntent(
          row.intent,
          row.account_ref,
          `pricing-card-expire:${input.propertyId}:${input.guestBookingId}:v1`,
        ),
      );
    } catch (error) {
      if (error instanceof PricingCardPaymentError) throw error;
      intent = check(await provider.retrievePaymentIntent(row.intent, row.account_ref));
    }
    if (intent.status === "succeeded") return settle(intent);
  }
  if (intent.status !== "canceled") return "pending";
  const occurredAt = input.now.toISOString();
  await client.query(
    `UPDATE finance.payments SET status='canceled',updated_at=$2::timestamptz,
      payment_metadata=payment_metadata || '{"providerStatus":"canceled"}'::jsonb
    WHERE id=$1 AND status='requires_action'`,
    [row.payment_id, occurredAt],
  );
  const expired = await client.query(
    `WITH changed AS (
      UPDATE booking.guest_bookings SET lifecycle_status='expired',updated_at=$3::timestamptz,
        cancellation_reason='pending_booking_expired'
      WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status='unpaid'
      RETURNING id
    ), event AS (
      INSERT INTO booking.booking_status_events
        (guest_booking_id,event_type,from_status,to_status,actor_type,public_visible,public_message,event_payload,occurred_at)
      SELECT id,'guest_booking.expired','pending_payment','expired','system',true,
        'The booking expired because the card payment was not completed.',$4::jsonb,$3::timestamptz FROM changed RETURNING id
    ), summary AS (
      UPDATE booking.direct_booking_summary_read_model SET lifecycle_status='expired',projected_at=$3::timestamptz
      WHERE guest_booking_id IN (SELECT id FROM changed) RETURNING guest_booking_id
    ) SELECT (SELECT count(*)::int FROM changed) AS bookings,(SELECT count(*)::int FROM event) AS events`,
    [
      input.guestBookingId,
      input.propertyId,
      occurredAt,
      { provider: "stripe", paymentIntentId: row.intent },
    ],
  );
  if (expired.rows[0]?.bookings !== 1 || expired.rows[0]?.events !== 1)
    throw new PricingCardPaymentError("conflict");
  await releaseRooms(row.booking_metadata);
  return "expired";
}
