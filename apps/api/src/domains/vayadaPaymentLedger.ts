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
    /** From the Stripe payment: test-mode money is recorded but never paid out. */
    livemode: boolean;
    occurredAt: string;
  },
): Promise<void> {
  const gross = stripeAmountMinor(input.amount, input.currency);
  const fee = stripeAmountMinor(input.feeAmount, input.currency);
  if (gross <= 0 || fee < 0 || fee > gross || !/^\d{4}-\d{2}-\d{2}$/.test(input.stayCheckOut))
    throw new Error("vayada Payment charge is invalid for the payout ledger.");
  await client.query(
    `INSERT INTO finance.hotel_payout_ledger (property_id, entry_kind, currency, gross_minor,
       fee_minor, net_minor, guest_booking_id, payment_id, stay_check_out, livemode, source_key,
       occurred_at)
     VALUES ($1::uuid, 'charge', $2, $3, $4, $5, $6::uuid, $7::uuid, $8::date, $9, $10,
       $11::timestamptz)`,
    [
      input.propertyId,
      input.currency.trim().toUpperCase(),
      gross,
      fee,
      gross - fee,
      input.guestBookingId,
      input.paymentId,
      input.stayCheckOut,
      input.livemode,
      `charge:${input.paymentId}`,
      input.occurredAt,
    ],
  );
}

/** A refund of a vayada Payment charge settled (VAY-2442): Vayada paid the guest back from its
 * own account, so the hotel is owed the refund less. The plan's fee on the refunded part comes
 * back to the hotel (rounded half up, as Stripe Connect refunds do); the vayada Payment fee is
 * kept (Flamur, 2026-10-31). Before a payout this lowers the balance; after it, the next payout.
 * Inside the refund's settlement transaction, which runs once per refund command. */
export async function recordVayadaPaymentRefund(
  client: Pick<pg.PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    refundCommandId: string;
    currency: string;
    paymentAmount: string;
    platformFeeAmount: string;
    refundAmount: string;
    livemode: boolean;
  },
): Promise<void> {
  const paid = BigInt(stripeAmountMinor(input.paymentAmount, input.currency));
  const planFee = BigInt(stripeAmountMinor(input.platformFeeAmount, input.currency));
  const refund = BigInt(stripeAmountMinor(input.refundAmount, input.currency));
  if (paid <= 0n || refund <= 0n || refund > paid || planFee > paid)
    throw new Error("vayada Payment refund is invalid for the payout ledger.");
  const planFeeBack = (planFee * refund * 2n + paid) / (2n * paid);
  const result = await insertEntry(client, {
    propertyId: input.propertyId,
    kind: "refund",
    currency: input.currency,
    gross: -refund,
    fee: -planFeeBack,
    guestBookingId: input.guestBookingId,
    paymentId: input.paymentId,
    livemode: input.livemode,
    sourceKey: `refund:${input.refundCommandId}`,
    onConflict: "fail",
  });
  // A refunded vayada payment was paid, so its charge row exists; anything else needs a person.
  if (result === "no_charge")
    throw new Error("vayada Payment refund has no charge in the payout ledger.");
}

/** A guest's card dispute on a vayada Payment charge moved money (VAY-2442). Withdrawn: the
 * disputed amount and Stripe's dispute fee leave Vayada's account and are taken from the hotel's
 * balance. Reinstated (Vayada won): the amount, and any fee Stripe gave back, are owed again.
 * Webhooks can arrive twice, so a second row for the same dispute phase is ignored. */
export async function recordVayadaPaymentDispute(
  client: Pick<pg.PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    disputeId: string;
    phase: "withdrawn" | "reinstated";
    currency: string;
    amountMinor: number;
    /** Stripe's dispute fee in the stay's currency: charged when withdrawn, given back when reinstated. */
    stripeFeeMinor: number;
    livemode: boolean;
  },
): Promise<"recorded" | "already_recorded" | "no_charge"> {
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    !Number.isSafeInteger(input.stripeFeeMinor) ||
    input.stripeFeeMinor < 0
  )
    throw new Error("vayada Payment dispute is invalid for the payout ledger.");
  const amount = BigInt(input.amountMinor);
  const fee = BigInt(input.stripeFeeMinor);
  const withdrawn = input.phase === "withdrawn";
  return insertEntry(client, {
    propertyId: input.propertyId,
    kind: withdrawn ? "dispute" : "dispute_reversal",
    currency: input.currency,
    gross: withdrawn ? -amount : amount,
    fee: withdrawn ? fee : -fee,
    guestBookingId: input.guestBookingId,
    paymentId: input.paymentId,
    livemode: input.livemode,
    sourceKey: `dispute:${input.disputeId}:${input.phase}`,
    onConflict: "ignore",
  });
}

/** Refunds and disputes net against the charge they belong to: same stay check-out (the payout
 * window), same currency. Without that charge the hotel was never credited the money, so
 * nothing is taken from it: "no_charge". */
async function insertEntry(
  client: Pick<pg.PoolClient, "query">,
  entry: {
    propertyId: string;
    kind: "refund" | "dispute" | "dispute_reversal";
    currency: string;
    gross: bigint;
    fee: bigint;
    guestBookingId: string;
    paymentId: string;
    livemode: boolean;
    sourceKey: string;
    onConflict: "fail" | "ignore";
  },
): Promise<"recorded" | "already_recorded" | "no_charge"> {
  const currency = entry.currency.trim().toUpperCase();
  const charge = (
    await client.query<{ checkOut: string; currency: string }>(
      `SELECT stay_check_out::text AS "checkOut", trim(currency) AS currency
       FROM finance.hotel_payout_ledger
       WHERE payment_id=$1::uuid AND property_id=$2::uuid AND entry_kind='charge'`,
      [entry.paymentId, entry.propertyId],
    )
  ).rows[0];
  if (!charge) return "no_charge";
  if (charge.currency !== currency)
    throw new Error("vayada Payment ledger entry is in another currency than its charge.");
  const inserted = await client.query(
    `INSERT INTO finance.hotel_payout_ledger (property_id, entry_kind, currency, gross_minor,
       fee_minor, net_minor, guest_booking_id, payment_id, stay_check_out, livemode, source_key,
       occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::date, $10, $11, clock_timestamp())
     ${entry.onConflict === "ignore" ? "ON CONFLICT (source_key) DO NOTHING" : ""}`,
    [
      entry.propertyId,
      entry.kind,
      currency,
      entry.gross.toString(),
      entry.fee.toString(),
      (entry.gross - entry.fee).toString(),
      entry.guestBookingId,
      entry.paymentId,
      charge.checkOut,
      entry.livemode,
      entry.sourceKey,
    ],
  );
  return inserted.rowCount === 1 ? "recorded" : "already_recorded";
}
