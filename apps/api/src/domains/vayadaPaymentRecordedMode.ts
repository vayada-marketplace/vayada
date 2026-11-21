import type pg from "pg";
import type { VayadaPaymentRecordedMode } from "./vayadaPaymentStripe.js";

/** VAY-2569: the mode each vayada Payment was made in, as recorded on its finance.payments row
 * when the charge was created (`payment_metadata.livemode`, Stripe's own answer). A refund is
 * found through its refund command. Null when the payment isn't found or has no recorded mode
 * (vayada Payment charges from before live mode); the router then follows the hotel lists. A
 * database error is thrown, so the Stripe call fails and its caller retries instead of guessing. */
export function createVayadaPaymentRecordedMode(
  pool: Pick<pg.Pool, "query">,
): VayadaPaymentRecordedMode {
  return async ({ propertyId, paymentIntentId, refundId }) => {
    const { rows } = paymentIntentId
      ? await pool.query<{ livemode: string | null }>(
          `SELECT payment_metadata->>'livemode' AS livemode
           FROM finance.payments
           WHERE property_id=$1::uuid AND provider_payment_intent_id=$2 AND payment_method='card'
             AND payment_metadata->>'chargeType'='vayada_payment'`,
          [propertyId, paymentIntentId],
        )
      : refundId
        ? await pool.query<{ livemode: string | null }>(
            `SELECT p.payment_metadata->>'livemode' AS livemode
             FROM finance.card_refund_commands c
             JOIN finance.payments p ON p.id=c.payment_id AND p.property_id=c.property_id
             WHERE c.property_id=$1::uuid AND c.provider_refund_id=$2
               AND p.payment_metadata->>'chargeType'='vayada_payment'`,
            [propertyId, refundId],
          )
        : { rows: [] };
    const modes = new Set(rows.map((row) => row.livemode));
    if (modes.size > 1)
      throw new Error("vayada Payment: one Stripe payment is recorded in two modes.");
    const [mode] = modes;
    return mode === "true" ? true : mode === "false" ? false : null;
  };
}
