import { stripeCurrencyHasZeroDecimals } from "@vayada/domain-finance";
import type pg from "pg";
import {
  authorizePricingCardRequest,
  PricingCardPaymentError,
  settlePricingCardPayment,
} from "./pricingCardPaymentCompletion.js";
import { applyCardRefundMoney } from "./pricingCardRefund.js";
import { stripeAmountDecimal } from "./stripeMoney.js";
import { recordVayadaPaymentDispute } from "./vayadaPaymentLedger.js";

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  livemode?: unknown;
  data?: { object?: unknown };
};
type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
export type VayadaPaymentWebhookResult = "handled" | "ignored";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const minor = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** Events from vayada Payment's own Stripe account (VAY-2442), after the route verified them.
 * Each one acts at most once however often Stripe sends it: settling and authorising are
 * idempotent, and a dispute phase writes one ledger row. Anything that can't be applied but
 * involves money is logged (ids only) for a person; a thrown error makes Stripe retry. */
export async function handleVayadaPaymentWebhookEvent(
  pool: Pick<pg.Pool, "connect">,
  event: StripeEvent,
  log: Log,
): Promise<VayadaPaymentWebhookResult> {
  const client = await pool.connect();
  try {
    return await handle(client, event, log);
  } finally {
    client.release();
  }
}

async function handle(
  client: pg.PoolClient,
  event: StripeEvent,
  log: Log,
): Promise<VayadaPaymentWebhookResult> {
  const type = text(event.type);
  const object = record(event.data?.object);
  if (type === "payment_intent.succeeded" || type === "payment_intent.amount_capturable_updated") {
    const paymentIntentId = text(object["id"]);
    const payment = paymentIntentId ? await findPayment(client, paymentIntentId) : null;
    if (!payment) return "ignored";
    const succeeded = type === "payment_intent.succeeded";
    const amountMinor = minor(succeeded ? object["amount_received"] : object["amount_capturable"]);
    const currency = text(object["currency"]);
    if (amountMinor === null || !currency) throw new Error("Stripe sent an invalid PaymentIntent.");
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const input = { paymentIntentId: paymentIntentId!, amountMinor, currency };
      if (succeeded) await settlePricingCardPayment(client, payment.propertyId, input);
      else await authorizePricingCardRequest(client, payment.propertyId, input);
      await client.query("COMMIT");
      return "handled";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!(error instanceof PricingCardPaymentError && error.code === "unavailable")) throw error;
      // A late or repeated event for a payment that's already settled, refunded or cancelled
      // needs nothing. Money held or taken for a booking that can't take it needs a person.
      const status = (await findPayment(client, paymentIntentId!))?.status;
      if (status === "requires_action" || status === "authorized")
        log.warn(
          { propertyId: payment.propertyId, paymentId: payment.id, eventId: text(event.id), type },
          "vayada Payment: Stripe reports money for a booking that can't take it; check it in Stripe",
        );
      return "ignored";
    }
  }
  if (type === "charge.dispute.funds_withdrawn" || type === "charge.dispute.funds_reinstated") {
    const disputeId = text(object["id"]);
    const paymentIntentId = text(object["payment_intent"]);
    const payment = paymentIntentId ? await findPayment(client, paymentIntentId) : null;
    if (!disputeId || !payment) return "ignored";
    const amountMinor = minor(object["amount"]);
    if (amountMinor === null || text(object["currency"])?.toUpperCase() !== payment.currency)
      throw new Error("Stripe sent a dispute that doesn't match its payment.");
    const withdrawn = type === "charge.dispute.funds_withdrawn";
    const transaction = (
      Array.isArray(object["balance_transactions"]) ? object["balance_transactions"] : []
    )
      .map(record)
      .find((bt) => (minor(bt["amount"]) ?? 0) * (withdrawn ? -1 : 1) > 0);
    const fee = transaction ? (minor(transaction["fee"]) ?? 0) : 0;
    // Withdrawn: Stripe's dispute fee is charged (fee > 0). Reinstated: a fee given back is < 0.
    const charged = withdrawn ? Math.max(fee, 0) : Math.max(-fee, 0);
    const stripeFeeMinor = transaction
      ? stayCurrencyFee(transaction, charged, payment.currency)
      : null;
    if (stripeFeeMinor === null)
      log.warn(
        { propertyId: payment.propertyId, paymentId: payment.id, disputeId, type },
        "vayada Payment: dispute fee unknown in the stay's currency; adjust the hotel's balance by hand",
      );
    let recorded: Awaited<ReturnType<typeof recordVayadaPaymentDispute>>;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      recorded = await recordVayadaPaymentDispute(client, {
        propertyId: payment.propertyId,
        guestBookingId: payment.guestBookingId,
        paymentId: payment.id,
        disputeId,
        phase: withdrawn ? "withdrawn" : "reinstated",
        currency: payment.currency,
        amountMinor,
        stripeFeeMinor: stripeFeeMinor ?? 0,
        livemode: event.livemode === true,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    if (recorded === "no_charge") {
      // The hotel was never credited this payment, so it can't owe the dispute.
      log.warn(
        { propertyId: payment.propertyId, paymentId: payment.id, disputeId, type },
        "vayada Payment: dispute on a payment the hotel was never credited; Vayada handles it",
      );
      return "ignored";
    }
    return "handled";
  }
  if (type === "refund.created" || type === "refund.updated" || type === "charge.refund.updated")
    return recordDashboardRefund(client, event, object, log);
  if (type === "charge.dispute.created" || type === "charge.dispute.closed") {
    const paymentIntentId = text(object["payment_intent"]);
    const payment = paymentIntentId ? await findPayment(client, paymentIntentId) : null;
    if (!payment) return "ignored";
    // Vayada answers disputes on its own account, with the hotel's information (terms §5).
    log.warn(
      {
        propertyId: payment.propertyId,
        paymentId: payment.id,
        disputeId: text(object["id"]),
        status: text(object["status"]),
        type,
      },
      type === "charge.dispute.created"
        ? "vayada Payment: a guest disputed a card payment; answer it in Stripe before its deadline"
        : "vayada Payment: a card dispute closed",
    );
    return "handled";
  }
  return "ignored";
}

/** A refund someone made in Stripe's dashboard on Vayada's own account (VAY-2442): recorded like
 * Vayada's own refunds, once it succeeded, so the payment, the booking and the hotel's balance
 * agree with Stripe. Vayada's own refund commands carry their command id and settle through the
 * refund sweep, so they're left alone here. A refund that would exceed what was paid, one on a
 * payment that never became paid, or one that fails after being recorded is flagged for a person
 * (ids only). */
async function recordDashboardRefund(
  client: pg.PoolClient,
  event: StripeEvent,
  refund: Record<string, unknown>,
  log: Log,
): Promise<VayadaPaymentWebhookResult> {
  const refundId = text(refund["id"]);
  const paymentIntentId = text(refund["payment_intent"]);
  if (!refundId || !paymentIntentId || text(record(refund["metadata"])["vayada_refund_command_id"]))
    return "ignored";
  const payment = await findPayment(client, paymentIntentId);
  if (!payment) return "ignored";
  const ids = { propertyId: payment.propertyId, paymentId: payment.id, refundId };
  const sourcePaymentId = `stripe-refund:${refundId}`;
  const recorded = async () =>
    (
      await client.query(
        "SELECT 1 FROM finance.payments WHERE source_system='finance' AND source_payment_id=$1",
        [sourcePaymentId],
      )
    ).rows.length > 0;
  const status = text(refund["status"]);
  if (status !== "succeeded") {
    if ((status === "failed" || status === "canceled") && (await recorded()))
      log.warn(
        { ...ids, status },
        "vayada Payment: a recorded dashboard refund failed at Stripe; correct the hotel's balance by hand",
      );
    return "ignored";
  }
  const amountMinor = minor(refund["amount"]);
  if (
    amountMinor === null ||
    amountMinor <= 0 ||
    text(refund["currency"])?.toUpperCase() !== payment.currency
  )
    throw new Error("Stripe sent a refund that doesn't match its payment.");
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    // The booking, then the payment: the order a cancellation's refund takes them in. Under these
    // locks a copy of this event that's being recorded at the same time has finished.
    await client.query(
      "SELECT 1 FROM booking.guest_bookings WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE",
      [payment.guestBookingId, payment.propertyId],
    );
    const current = (
      await client.query<{ status: string }>(
        "SELECT status FROM finance.payments WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE",
        [payment.id, payment.propertyId],
      )
    ).rows[0]?.status;
    if (await recorded()) {
      await client.query("ROLLBACK");
      return "handled";
    }
    if (current === "requires_action" || current === "authorized" || current === "pending")
      // Stripe's payment event may still be on its way; Stripe retries this one until it's paid
      // here, or the payment ends unpaid (below).
      throw new Error("vayada Payment refund arrived before its payment was settled.");
    if (current !== "paid" && current !== "partially_refunded" && current !== "refunded") {
      await client.query("ROLLBACK");
      log.warn(
        { ...ids, status: current },
        "vayada Payment: a dashboard refund on a payment that was never paid here; check it in Stripe",
      );
      return "ignored";
    }
    await applyCardRefundMoney(client, {
      propertyId: payment.propertyId,
      guestBookingId: payment.guestBookingId,
      paymentId: payment.id,
      amount: stripeAmountDecimal(amountMinor, payment.currency),
      currency: payment.currency,
      providerRefundId: refundId,
      providerPaymentIntentId: paymentIntentId,
      sourcePaymentId,
      idempotencyKey: sourcePaymentId,
      ledgerSourceKey: `refund:stripe:${refundId}`,
      metadata: { source: "stripe_dashboard", eventId: text(event.id) },
    });
    await client.query("COMMIT");
    return "handled";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message === "A card refund exceeds its payment.") {
      log.warn(
        ids,
        "vayada Payment: a dashboard refund exceeds what Vayada recorded as paid; check it in Stripe",
      );
      return "ignored";
    }
    // A concurrent copy of this event recorded it first.
    if ((error as { code?: string }).code === "23505") return "handled";
    throw error;
  }
}

async function findPayment(client: Pick<pg.PoolClient, "query">, paymentIntentId: string) {
  const row = (
    await client.query(
      `SELECT id::text,property_id::text AS "propertyId",guest_booking_id::text AS "guestBookingId",
         trim(currency) AS currency,status
       FROM finance.payments
       WHERE provider_payment_intent_id=$1 AND payment_method='card'
         AND payment_kind IN ('full','deposit')
         AND payment_metadata->>'chargeType'='vayada_payment'`,
      [paymentIntentId],
    )
  ).rows;
  return row.length === 1
    ? (row[0] as {
        id: string;
        propertyId: string;
        guestBookingId: string;
        currency: string;
        status: string;
      })
    : null;
}

/** Stripe's fee comes in the account's settlement currency; the hotel's balance is in the stay's.
 * Convert with the balance transaction's own rate (stay amount × rate = settlement amount).
 * Null when it can't be converted. */
export function stayCurrencyFee(
  transaction: Record<string, unknown>,
  feeMinor: number,
  stayCurrency: string,
): number | null {
  if (feeMinor === 0) return 0;
  const settlement = text(transaction["currency"])?.toUpperCase();
  if (!settlement) return null;
  if (settlement === stayCurrency) return feeMinor;
  const rate = Number(transaction["exchange_rate"]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const scale = (currency: string) => (stripeCurrencyHasZeroDecimals(currency) ? 1 : 100);
  const converted = Math.round(((feeMinor / scale(settlement)) * scale(stayCurrency)) / rate);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}
