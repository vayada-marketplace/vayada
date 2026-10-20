import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { stripeAmountMinor } from "./stripeMoney.js";

/** Where Vayada's record of a pricing-v2 card payment or refund and Stripe's disagree (VAY-2205).
 * Read-only: a person decides what to do; nothing is changed here. */
export type PricingCardMismatch = Readonly<{
  kind:
    | "payment_status"
    | "payment_amount"
    | "refunded_at_stripe"
    | "disputed"
    | "refund_failed_later"
    | "refund_failed"
    | "refund_stuck"
    | "stripe_unreachable";
  propertyId: string;
  guestBookingId: string | null;
  reference: string;
  detail: string;
}>;

const STRIPE_STATUS: Readonly<Record<string, string>> = {
  authorized: "requires_capture",
  paid: "succeeded",
  partially_refunded: "succeeded",
  refunded: "succeeded",
};

/** Compares the last `windowDays` of pricing-v2 card payments and automatic refunds with Stripe. */
export async function reconcilePricingCardPayments(
  pool: Pick<Pool, "query">,
  provider: StripeBookingPaymentProvider,
  windowDays = 30,
): Promise<{ payments: number; refunds: number; mismatches: PricingCardMismatch[] }> {
  const mismatches: PricingCardMismatch[] = [];
  const payments = (
    await pool.query(
      `SELECT payment.id,payment.property_id,payment.guest_booking_id,payment.status,payment.amount::text AS amount,
         payment.refunded_amount::text AS refunded,trim(payment.currency) AS currency,
         payment.provider_payment_intent_id AS intent,account.provider_account_id AS "accountRef",
         EXISTS(SELECT 1 FROM finance.card_refund_commands command
           WHERE command.payment_id=payment.id AND command.status='pending') AS "refundPending"
       FROM finance.payments payment
       JOIN finance.payment_provider_accounts account
         ON account.id=payment.provider_account_id AND account.property_id=payment.property_id
       JOIN booking.guest_bookings booking
         ON booking.id=payment.guest_booking_id AND booking.property_id=payment.property_id
       WHERE payment.payment_method='card' AND payment.payment_kind IN ('full','deposit')
         AND payment.payment_metadata->>'chargeType'='direct' AND payment.provider_payment_intent_id IS NOT NULL
         AND payment.status IN ('authorized','paid','partially_refunded','refunded')
         AND booking.booking_metadata->>'targetSource'='pricing_quote_draft'
         AND payment.updated_at>=now()-make_interval(days=>$1)
       ORDER BY payment.updated_at DESC LIMIT 500`,
      [windowDays],
    )
  ).rows;
  for (const payment of payments) {
    const at = {
      propertyId: payment.property_id,
      guestBookingId: payment.guest_booking_id,
      reference: payment.id,
    };
    try {
      const intent = await provider.retrievePaymentIntent(payment.intent, payment.accountRef);
      if (intent.status !== STRIPE_STATUS[payment.status])
        mismatches.push({
          ...at,
          kind: "payment_status",
          detail: `Vayada ${payment.status}, Stripe ${intent.status}`,
        });
      if (intent.amountMinor !== stripeAmountMinor(payment.amount, payment.currency))
        mismatches.push({
          ...at,
          kind: "payment_amount",
          detail: `Vayada ${payment.amount}, Stripe ${intent.amountMinor} minor`,
        });
      // A refund under way is expected to differ until it settles.
      if (
        !payment.refundPending &&
        intent.amountRefundedMinor != null &&
        intent.amountRefundedMinor !== stripeAmountMinor(payment.refunded, payment.currency)
      )
        mismatches.push({
          ...at,
          kind: "refunded_at_stripe",
          detail: `Vayada refunded ${payment.refunded}, Stripe ${intent.amountRefundedMinor} minor`,
        });
      if (intent.disputed)
        mismatches.push({
          ...at,
          kind: "disputed",
          detail: "The guest disputed the card payment.",
        });
    } catch (error) {
      mismatches.push({ ...at, kind: "stripe_unreachable", detail: message(error) });
    }
  }
  const refunds = (
    await pool.query(
      `SELECT id,property_id,guest_booking_id,status,provider_refund_id AS "refundId",
         provider_account_ref AS "accountRef",failure_reason AS reason,
         created_at<now()-interval '1 day' AS old
       FROM finance.card_refund_commands command
       WHERE (status='succeeded' AND settled_at>=now()-make_interval(days=>$1))
          -- A failure the hotel retried is no longer a difference: the newer refund is checked.
          OR (status='failed' AND settled_at>=now()-make_interval(days=>$1)
              AND NOT EXISTS (SELECT 1 FROM finance.card_refund_commands newer
                WHERE newer.payment_id=command.payment_id AND newer.property_id=command.property_id
                  AND newer.created_at>command.created_at))
          OR status='pending'
       ORDER BY created_at DESC LIMIT 500`,
      [windowDays],
    )
  ).rows;
  for (const refund of refunds) {
    const at = {
      propertyId: refund.property_id,
      guestBookingId: refund.guest_booking_id,
      reference: refund.id,
    };
    if (refund.status === "failed") {
      mismatches.push({ ...at, kind: "refund_failed", detail: refund.reason ?? "failed" });
      continue;
    }
    if (refund.status === "pending") {
      if (refund.old)
        mismatches.push({
          ...at,
          kind: "refund_stuck",
          detail: refund.reason ?? "still pending at Stripe",
        });
      continue;
    }
    // next-api hears no refund webhooks yet: a card refund can still fail after it succeeded.
    try {
      const stripe = await provider.retrieveRefund(refund.refundId, refund.accountRef);
      if (stripe.status !== "succeeded")
        mismatches.push({
          ...at,
          kind: "refund_failed_later",
          detail: `Stripe ${stripe.status}${stripe.failureReason ? ` (${stripe.failureReason})` : ""}`,
        });
    } catch (error) {
      mismatches.push({ ...at, kind: "stripe_unreachable", detail: message(error) });
    }
  }
  return { payments: payments.length, refunds: refunds.length, mismatches };
}

const message = (error: unknown) =>
  (error instanceof Error ? error.message : "Stripe request failed").slice(0, 200);

/** Emails the mismatches at most once a day while there are any (ids only, no guest data). */
export function createPricingCardReconciliationAlert(options: {
  to: string;
  delivery: {
    send(input: {
      to: string;
      subject: string;
      text: string;
      idempotencyKey: string;
      emailProduct?: "platform";
    }): Promise<void>;
  };
}) {
  return async (mismatches: readonly PricingCardMismatch[], now = new Date()): Promise<boolean> => {
    if (!mismatches.length) return false;
    const day = now.toISOString().slice(0, 10);
    const text = [
      `The daily card payment check on ${day} found ${mismatches.length} difference(s) between Vayada and Stripe.`,
      "Each one needs a person: check the payment or refund in the hotel's Stripe account and in the PMS.",
      "",
      ...mismatches.map(
        (m) =>
          `- ${m.kind}: property ${m.propertyId}, booking ${m.guestBookingId ?? "-"}, ${m.reference}: ${m.detail}`,
      ),
    ].join("\n");
    await options.delivery.send({
      to: options.to,
      subject: `Vayada: ${mismatches.length} card payment difference(s) with Stripe`,
      text,
      idempotencyKey: `pricing-card-reconciliation:${day}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`,
      // VAY-2293: the Resend webhook acknowledges platform events instead of retrying them.
      emailProduct: "platform",
    });
    return true;
  };
}
