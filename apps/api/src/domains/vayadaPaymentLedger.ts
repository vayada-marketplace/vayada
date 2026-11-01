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
 * own account, so the hotel is owed that much less, but never twice for the same money: what a
 * dispute already took isn't taken again (see paymentExposure). The plan's fee on everything
 * refunded so far comes back to the hotel (rounded half up on the running total, as Stripe Connect
 * refunds do); the vayada Payment fee is kept (Flamur, 2026-10-31). Inside the refund's settlement
 * transaction, after the payment's refunded amount includes this refund; once per refund. */
export async function recordVayadaPaymentRefund(
  client: Pick<pg.PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    /** refund:<command> for Vayada's own refunds, refund:stripe:<re_…> for one made in Stripe. */
    sourceKey: string;
    currency: string;
    platformFeeAmount: string;
    livemode: boolean;
  },
): Promise<void> {
  const state = await paymentExposure(client, input);
  const planFee = BigInt(stripeAmountMinor(input.platformFeeAmount, input.currency));
  if (!state || state.refunded <= 0n || state.refunded > state.paid || planFee > state.paid)
    throw new Error("vayada Payment refund is invalid for the payout ledger.");
  const target = min(state.paid, state.refunded + state.disputed);
  const planFeeBack = (planFee * state.refunded * 2n + state.paid) / (2n * state.paid);
  const result = await insertEntry(client, {
    propertyId: input.propertyId,
    kind: "refund",
    currency: input.currency,
    gross: -positive(target - state.taken),
    fee: -positive(planFeeBack - state.planFeeBack),
    guestBookingId: input.guestBookingId,
    paymentId: input.paymentId,
    livemode: input.livemode,
    sourceKey: input.sourceKey,
    onConflict: "fail",
  });
  // A refunded vayada payment was paid, so its charge row exists; anything else needs a person.
  if (result === "no_charge")
    throw new Error("vayada Payment refund has no charge in the payout ledger.");
}

/** A guest's card dispute on a vayada Payment charge moved money (VAY-2442). Withdrawn: the
 * disputed amount and Stripe's dispute fee leave Vayada's account and are taken from the hotel's
 * balance, but never twice: refunds and disputes of one payment together take at most what was
 * paid, whichever Stripe reports first, so after a full refund a dispute takes nothing, not even
 * the fee (Flamur, 2026-11-01; Vayada contests it with the refund). Reinstated (Vayada won): what
 * the dispute took comes back, less what refunds have taken since, and the fee as far as Stripe
 * returned it. Inside the caller's transaction; webhooks can arrive twice, so a second row for the
 * same dispute phase is ignored. Stripe allows one dispute per charge. */
export async function recordVayadaPaymentDispute(
  client: Pick<pg.PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    disputeId: string;
    phase: "withdrawn" | "reinstated";
    currency: string;
    /** The disputed amount (Stripe's dispute.amount). */
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
  const state = await paymentExposure(client, input);
  if (!state) return "no_charge";
  const sourceKey = `dispute:${input.disputeId}:${input.phase}`;
  if (state.sourceKeys.has(sourceKey)) return "already_recorded";
  let gross: bigint, entryFee: bigint;
  if (input.phase === "withdrawn") {
    const taken = positive(min(state.paid, state.refunded + state.disputed + amount) - state.taken);
    gross = -taken;
    entryFee = taken > 0n ? fee : 0n;
  } else {
    const withdrawn = state.withdrawn.get(input.disputeId);
    if (!withdrawn) {
      if (!state.charged) return "no_charge";
      // Its withdrawal is still on its way (Stripe retries failed events): a reversal now would
      // leave the hotel without what the withdrawal later takes. Stripe retries this one too.
      throw new Error("vayada Payment dispute reinstated before its withdrawal was recorded.");
    }
    const target = min(state.paid, state.refunded + state.disputed - withdrawn.taken);
    gross = min(amount, positive(state.taken - target));
    entryFee = -min(fee, withdrawn.fee);
  }
  return insertEntry(client, {
    propertyId: input.propertyId,
    kind: input.phase === "withdrawn" ? "dispute" : "dispute_reversal",
    currency: input.currency,
    gross,
    fee: entryFee,
    guestBookingId: input.guestBookingId,
    paymentId: input.paymentId,
    livemode: input.livemode,
    sourceKey,
    onConflict: "ignore",
  });
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const positive = (value: bigint) => (value > 0n ? value : 0n);

/** One payment's refunds and disputes as the hotel bears them, under the payment's row lock (the
 * lock a refund's settlement takes too, so they never interleave). Refunds and open disputes
 * together take at most what was paid: `taken` is what the ledger already took, `disputed` what
 * open disputes took, `refunded` what Stripe refunded (the payment's refunded amount). */
async function paymentExposure(
  client: Pick<pg.PoolClient, "query">,
  input: { propertyId: string; paymentId: string; currency: string },
) {
  const payment = (
    await client.query<{ amount: string; refunded: string }>(
      `SELECT amount::text AS amount, refunded_amount::text AS refunded FROM finance.payments
       WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
      [input.paymentId, input.propertyId],
    )
  ).rows[0];
  if (!payment) return null;
  const rows = (
    await client.query<{ kind: string; gross: string; fee: string; sourceKey: string }>(
      `SELECT entry_kind AS kind, gross_minor::text AS gross, fee_minor::text AS fee,
         source_key AS "sourceKey"
       FROM finance.hotel_payout_ledger WHERE payment_id=$1::uuid AND property_id=$2::uuid`,
      [input.paymentId, input.propertyId],
    )
  ).rows;
  const sourceKeys = new Set(rows.map((row) => row.sourceKey));
  const withdrawn = new Map<string, { taken: bigint; fee: bigint }>();
  let taken = 0n,
    planFeeBack = 0n,
    disputed = 0n;
  for (const row of rows) {
    if (row.kind === "charge") continue;
    taken -= BigInt(row.gross);
    if (row.kind === "refund") planFeeBack -= BigInt(row.fee);
    const dispute = /^dispute:(.+):withdrawn$/.exec(row.sourceKey);
    if (row.kind === "dispute" && dispute) {
      withdrawn.set(dispute[1], { taken: -BigInt(row.gross), fee: BigInt(row.fee) });
      if (!sourceKeys.has(`dispute:${dispute[1]}:reinstated`)) disputed -= BigInt(row.gross);
    }
  }
  return {
    paid: BigInt(stripeAmountMinor(payment.amount, input.currency)),
    refunded: BigInt(stripeAmountMinor(payment.refunded, input.currency)),
    charged: rows.some((row) => row.kind === "charge"),
    taken,
    planFeeBack,
    disputed,
    withdrawn,
    sourceKeys,
  };
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
