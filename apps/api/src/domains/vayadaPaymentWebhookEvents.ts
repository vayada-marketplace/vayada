import { stripeCurrencyHasZeroDecimals } from "@vayada/domain-finance";
import type pg from "pg";
import {
  authorizePricingCardRequest,
  PricingCardPaymentError,
  settlePricingCardPayment,
} from "./pricingCardPaymentCompletion.js";
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
  pool: Pick<pg.Pool, "connect" | "query">,
  event: StripeEvent,
  log: Log,
): Promise<VayadaPaymentWebhookResult> {
  const type = text(event.type);
  const object = record(event.data?.object);
  if (type === "payment_intent.succeeded" || type === "payment_intent.amount_capturable_updated") {
    const paymentIntentId = text(object["id"]);
    const payment = paymentIntentId ? await findPayment(pool, paymentIntentId) : null;
    if (!payment) return "ignored";
    const succeeded = type === "payment_intent.succeeded";
    const amountMinor = minor(succeeded ? object["amount_received"] : object["amount_capturable"]);
    const currency = text(object["currency"]);
    if (amountMinor === null || !currency) throw new Error("Stripe sent an invalid PaymentIntent.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const input = { paymentIntentId: paymentIntentId!, amountMinor, currency };
      if (succeeded) await settlePricingCardPayment(client, payment.propertyId, input);
      else await authorizePricingCardRequest(client, payment.propertyId, input);
      await client.query("COMMIT");
      return "handled";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // The booking can no longer take this payment (expired, cancelled): a person must look.
      if (error instanceof PricingCardPaymentError && error.code === "unavailable") {
        log.warn(
          { propertyId: payment.propertyId, paymentId: payment.id, eventId: text(event.id), type },
          "vayada Payment: Stripe reports money for a booking that can't take it; refund the guest",
        );
        return "ignored";
      }
      throw error;
    } finally {
      client.release();
    }
  }
  if (type === "charge.dispute.funds_withdrawn" || type === "charge.dispute.funds_reinstated") {
    const disputeId = text(object["id"]);
    const paymentIntentId = text(object["payment_intent"]);
    const payment = paymentIntentId ? await findPayment(pool, paymentIntentId) : null;
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
      : 0;
    if (stripeFeeMinor === null)
      log.warn(
        { propertyId: payment.propertyId, paymentId: payment.id, disputeId },
        "vayada Payment: dispute fee not in the stay's currency; add it to the hotel's balance by hand",
      );
    await recordVayadaPaymentDispute(pool as Pick<pg.PoolClient, "query">, {
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
    return "handled";
  }
  if (type === "charge.dispute.created" || type === "charge.dispute.closed") {
    const paymentIntentId = text(object["payment_intent"]);
    const payment = paymentIntentId ? await findPayment(pool, paymentIntentId) : null;
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

/** The vayada Payment charge behind a PaymentIntent of Vayada's own account, if any. */
async function findPayment(pool: Pick<pg.Pool, "query">, paymentIntentId: string) {
  const row = (
    await pool.query(
      `SELECT id::text,property_id::text AS "propertyId",guest_booking_id::text AS "guestBookingId",
         trim(currency) AS currency
       FROM finance.payments
       WHERE provider_payment_intent_id=$1 AND payment_method='card'
         AND payment_kind IN ('full','deposit')
         AND payment_metadata->>'chargeType'='vayada_payment'`,
      [paymentIntentId],
    )
  ).rows;
  return row.length === 1
    ? (row[0] as { id: string; propertyId: string; guestBookingId: string; currency: string })
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
