import type pg from "pg";
import { stripeAmountMinor } from "./stripeMoney.js";

/** A paid vayada Payment charge (VAY-2442): Vayada now owes the hotel the guest's payment less
 * Vayada's fee, in the stay's currency, payable once the stay has checked out. Inside the
 * caller's transaction, right where the payment becomes paid; a second row for the same payment
 * is refused (source key and one-charge index), never added twice. */
export async function recordVayadaPaymentCharge(
  client: Pick<pg.PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    currency: string;
    amount: string;
    feeAmount: string;
    stayCheckOut: string;
    occurredAt: string;
  },
): Promise<void> {
  const gross = stripeAmountMinor(input.amount, input.currency);
  const fee = stripeAmountMinor(input.feeAmount, input.currency);
  if (gross <= 0 || fee < 0 || fee > gross || !/^\d{4}-\d{2}-\d{2}$/.test(input.stayCheckOut))
    throw new Error("vayada Payment charge is invalid for the payout ledger.");
  await client.query(
    `INSERT INTO finance.hotel_payout_ledger (property_id, entry_kind, currency, gross_minor,
       fee_minor, net_minor, guest_booking_id, payment_id, stay_check_out, source_key, occurred_at)
     VALUES ($1::uuid, 'charge', $2, $3, $4, $5, $6::uuid, $7::uuid, $8::date, $9, $10::timestamptz)`,
    [
      input.propertyId,
      input.currency.trim().toUpperCase(),
      gross,
      fee,
      gross - fee,
      input.guestBookingId,
      input.paymentId,
      input.stayCheckOut,
      `charge:${input.paymentId}`,
      input.occurredAt,
    ],
  );
}
