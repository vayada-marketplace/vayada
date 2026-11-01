import { createHash } from "node:crypto";
import { recordVayadaPaymentRefund } from "./vayadaPaymentLedger.js";
import { isVayadaPaymentAccountRef } from "./vayadaPaymentStripe.js";
import type { Pool, PoolClient } from "pg";
import { pricingAmountStep, pricingCurrencyScale } from "@vayada/domain-pms";
import { pricingMinorDecimal } from "./pricingCardPayment.js";
import type { StripeBookingPaymentProvider, StripeBookingRefund } from "./stripeBookingPayments.js";
import { stripeAmountMinor } from "./stripeMoney.js";

/** "unavailable": no paid card payment to refund; "conflict": another refund of it is under way. */
export class PricingCardRefundError extends Error {
  constructor(readonly code: "unavailable" | "conflict") {
    super(`Pricing card refund ${code}`);
  }
}

export type StagedPricingCardRefund = Readonly<{
  commandId: string;
  amount: string;
  currency: string;
}>;

const uuidFrom = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A stored two-decimal amount in the pricing currency's minor units; null if it doesn't fit. */
/** A two-decimal amount in the currency's pricing minor units; null when it doesn't fit. */
export function pricingMinor(amount: string, currency: string): bigint | null {
  const scale = pricingCurrencyScale(currency);
  const match = /^(\d{1,13})\.(\d{2})$/.exec(amount);
  if (scale === null || !match) return null;
  const cents = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  const minor = cents * 10n ** BigInt(scale);
  return minor % 100n === 0n ? minor / 100n : null;
}

/** What a cancelled paid stay gets back: what was paid online minus what the booked terms keep,
 * rounded up to the currency's step in the guest's favour, never more than was paid (VAY-2205). */
export function pricingCardRefundMinor(paidMinor: bigint, retainedMinor: bigint, currency: string) {
  const step = BigInt(pricingAmountStep(currency));
  const owed = paidMinor - retainedMinor;
  if (owed <= 0n) return 0n;
  const rounded = ((owed + step - 1n) / step) * step;
  return rounded > paidMinor ? paidMinor : rounded;
}

/** The cancel preview's money for a paid card stay: what was paid and what the booked terms give
 * back, by the same rule as `stagePricingCardRefund`. Null without a paid card payment. */
export async function previewPricingCardRefund(
  db: Pick<PoolClient, "query">,
  input: { propertyId: string; guestBookingId: string; retainedMinor: string },
): Promise<{ paidMinor: bigint; refundMinor: bigint; currency: string } | null> {
  const payment = (
    await db.query(
      `SELECT payment.amount::text AS amount,trim(payment.currency) AS currency
       FROM booking.guest_bookings booking
       JOIN finance.payments payment
         ON payment.id=booking.active_card_payment_id AND payment.property_id=booking.property_id
       WHERE booking.property_id=$1::uuid AND booking.id=$2::uuid AND payment.payment_method='card'
         AND payment.status='paid' AND payment.refunded_amount=0
         AND payment.payment_metadata->>'chargeType' IN ('direct','vayada_payment')
         AND payment.currency=booking.currency
         AND booking.payment_status IN ('paid','partially_paid')
         AND booking.booking_metadata->>'targetSource'='pricing_quote_draft'
         AND booking.booking_metadata->>'paymentMethod'='card'
         -- Only the card was paid: once the rest was paid at the property too, the hotel settles
         -- the cancel itself (VAY-2205).
         AND NOT EXISTS (SELECT 1 FROM finance.payments other
           WHERE other.property_id=booking.property_id AND other.guest_booking_id=booking.id
             AND other.id<>payment.id AND other.payment_kind<>'refund'
             AND other.status IN ('authorized','pending','paid','partially_refunded'))`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const paid = payment && pricingMinor(payment.amount, payment.currency);
  if (!paid || !/^(0|[1-9][0-9]*)$/.test(input.retainedMinor)) return null;
  return {
    paidMinor: paid,
    refundMinor: pricingCardRefundMinor(paid, BigInt(input.retainedMinor), payment.currency),
    currency: payment.currency,
  };
}

/** Inside the caller's cancel transaction, after it locked the booking row and the property's
 * inventory: records the refund the booked terms owe on the stay's paid card payment, or nothing
 * when they keep it all. The refund reaches Stripe only after the caller commits
 * (`executePricingCardRefund`), so a rollback never refunds. A replay of the same command returns
 * the same refund; a second refund of a payment whose refund hasn't failed is a conflict. */
export async function stagePricingCardRefund(
  client: Pick<PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    retainedMinor: string;
    requestedBy: "guest" | "host";
    commandKey: string;
    occurredAt: Date;
  },
): Promise<StagedPricingCardRefund | null> {
  const payment = (
    await client.query(
      `SELECT payment.id,payment.amount::text AS amount,payment.refunded_amount::text AS refunded,
         trim(payment.currency) AS currency,payment.status,payment.payment_method AS method,
         payment.provider_payment_intent_id AS intent,account.provider_account_id AS "accountRef",
         payment.payment_metadata->>'chargeType' AS "chargeType",trim(booking.currency) AS "bookingCurrency",
         booking.payment_status AS "bookingPaid",booking.booking_metadata->>'targetSource' AS source,
         booking.booking_metadata->>'paymentMethod' AS "bookedMethod",
         NOT EXISTS (SELECT 1 FROM finance.payments other
           WHERE other.property_id=booking.property_id AND other.guest_booking_id=booking.id
             AND other.id<>payment.id AND other.payment_kind<>'refund'
             AND other.status IN ('authorized','pending','paid','partially_refunded')) AS "onlyCard"
       FROM booking.guest_bookings booking
       JOIN finance.payments payment
         ON payment.id=booking.active_card_payment_id AND payment.property_id=booking.property_id
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id=payment.provider_account_id AND account.property_id=payment.property_id
       WHERE booking.property_id=$1::uuid AND booking.id=$2::uuid
       FOR UPDATE OF payment`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const key = `pricing-card-refund:${input.propertyId}:${input.guestBookingId}:${input.requestedBy}:${createHash("sha256").update(input.commandKey).digest("hex")}`;
  const commandId = uuidFrom(key);
  const replay = (
    await client.query(
      `SELECT payment_id,amount::text AS amount,trim(currency) AS currency FROM finance.card_refund_commands
       WHERE idempotency_key=$1`,
      [key],
    )
  ).rows[0];
  if (replay) {
    if (replay.payment_id !== payment?.id) throw new PricingCardRefundError("conflict");
    return { commandId, amount: replay.amount, currency: replay.currency };
  }
  const paid = payment && pricingMinor(payment.amount, payment.currency);
  if (
    !payment ||
    payment.method !== "card" ||
    payment.status !== "paid" ||
    // Refunds run on the hotel's own Stripe account: only its direct charges, in the stay's
    // currency, of a paid pricing-v2 card stay.
    // vayada Payment (VAY-2442) refunds on Vayada's own account, by its vayada:<property> reference.
    !(payment.chargeType === "direct" || payment.chargeType === "vayada_payment") ||
    payment.currency !== payment.bookingCurrency ||
    // A card deposit leaves the rest to pay at the property (VAY-2205).
    (payment.bookingPaid !== "paid" && payment.bookingPaid !== "partially_paid") ||
    payment.source !== "pricing_quote_draft" ||
    payment.bookedMethod !== "card" ||
    // Once the rest of a deposit was paid at the property, the hotel settles the cancel itself.
    payment.onlyCard !== true ||
    payment.refunded !== "0.00" ||
    !paid ||
    typeof payment.intent !== "string" ||
    typeof payment.accountRef !== "string" ||
    !(payment.chargeType === "vayada_payment"
      ? isVayadaPaymentAccountRef(payment.accountRef)
      : payment.accountRef.startsWith("acct_")) ||
    !/^(0|[1-9][0-9]*)$/.test(input.retainedMinor)
  )
    throw new PricingCardRefundError("unavailable");
  const refundMinor = pricingCardRefundMinor(paid, BigInt(input.retainedMinor), payment.currency);
  if (refundMinor === 0n) return null;
  const amount = pricingMinorDecimal(refundMinor.toString(), payment.currency);
  try {
    await client.query(
      `INSERT INTO finance.card_refund_commands
         (id,property_id,guest_booking_id,payment_id,idempotency_key,requested_by,amount,amount_minor,currency,
          provider_account_ref,provider_payment_intent_id,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10,$11,$12,$12,$12)`,
      [
        commandId,
        input.propertyId,
        input.guestBookingId,
        payment.id,
        key,
        input.requestedBy,
        amount,
        stripeAmountMinor(amount, payment.currency),
        payment.currency,
        payment.accountRef,
        payment.intent,
        input.occurredAt.toISOString(),
      ],
    );
  } catch (error) {
    // 0494's one-live-refund index: someone else's cancel already refunds this payment.
    if ((error as { code?: string }).code === "23505") throw new PricingCardRefundError("conflict");
    throw error;
  }
  return { commandId, amount, currency: payment.currency };
}

/** A failed refund asked again, for the same amount, inside the caller's transaction (VAY-2205).
 * Only the stay's latest refund, and only once it failed: a pending or settled one is left alone.
 * Replays of the same command return the same refund. */
export async function retryPricingCardRefund(
  client: Pick<PoolClient, "query">,
  input: { propertyId: string; guestBookingId: string; commandKey: string; occurredAt: Date },
): Promise<StagedPricingCardRefund> {
  const key = `pricing-card-refund-retry:${input.propertyId}:${input.guestBookingId}:${createHash("sha256").update(input.commandKey).digest("hex")}`;
  const commandId = uuidFrom(key);
  // The card payment first, as a cancel takes it, so a retry can't race a settle of the same stay.
  const payment = (
    await client.query(
      `SELECT payment.id FROM booking.guest_bookings booking
       JOIN finance.payments payment
         ON payment.id=booking.active_card_payment_id AND payment.property_id=booking.property_id
       WHERE booking.property_id=$1::uuid AND booking.id=$2::uuid FOR UPDATE OF payment`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  const replay = (
    await client.query(
      `SELECT amount::text AS amount,trim(currency) AS currency FROM finance.card_refund_commands
       WHERE idempotency_key=$1 AND guest_booking_id=$2`,
      [key, input.guestBookingId],
    )
  ).rows[0];
  if (replay) return { commandId, amount: replay.amount, currency: replay.currency };
  const failed = (
    await client.query(
      `SELECT payment_id,amount::text AS amount,amount_minor,trim(currency) AS currency,provider_account_ref,
         provider_payment_intent_id,status
       FROM finance.card_refund_commands WHERE property_id=$1 AND guest_booking_id=$2
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [input.propertyId, input.guestBookingId],
    )
  ).rows[0];
  if (!payment || !failed || failed.status !== "failed" || failed.payment_id !== payment.id)
    throw new PricingCardRefundError("unavailable");
  try {
    await client.query(
      `INSERT INTO finance.card_refund_commands
         (id,property_id,guest_booking_id,payment_id,idempotency_key,requested_by,amount,amount_minor,currency,
          provider_account_ref,provider_payment_intent_id,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'host',$6::numeric,$7,$8,$9,$10,$11,$11,$11)`,
      [
        commandId,
        input.propertyId,
        input.guestBookingId,
        payment.id,
        key,
        failed.amount,
        failed.amount_minor,
        failed.currency,
        failed.provider_account_ref,
        failed.provider_payment_intent_id,
        input.occurredAt.toISOString(),
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new PricingCardRefundError("conflict");
    throw error;
  }
  return { commandId, amount: failed.amount, currency: failed.currency };
}

type Command = {
  id: string;
  property_id: string;
  guest_booking_id: string;
  payment_id: string;
  idempotency_key: string;
  requested_by: string;
  amount: string;
  amount_minor: string;
  currency: string;
  provider_account_ref: string;
  provider_payment_intent_id: string;
  status: string;
  provider_refund_id: string | null;
  attempts: number;
  waiting: boolean;
  booking_reference: string;
  has_application_fee: boolean;
};

/** After the cancel committed (and from the sweep): asks Stripe for the refund once, or finds the
 * one it already made, and settles it when Stripe says it succeeded. Busy elsewhere, or already
 * settled: nothing happens. Stripe errors keep the command pending with a later retry; after
 * MAX_ATTEMPTS a refund Stripe never made fails, with an audit event and a warning. */
export async function executePricingCardRefund(
  pool: Pick<Pool, "connect">,
  provider: StripeBookingPaymentProvider,
  commandId: string,
): Promise<"succeeded" | "pending" | "failed" | "busy"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = (
      await client.query<Command>(
        `SELECT id,property_id,guest_booking_id,payment_id,idempotency_key,requested_by,amount::text AS amount,
           amount_minor::text AS amount_minor,trim(currency) AS currency,provider_account_ref,
           provider_payment_intent_id,status,provider_refund_id,attempts,
           attempts>0 AND next_attempt_at>clock_timestamp() AS waiting,
           (SELECT public_reference FROM booking.guest_bookings booking
            WHERE booking.id=command.guest_booking_id AND booking.property_id=command.property_id)
             AS booking_reference,
           COALESCE((SELECT COALESCE((payment.payment_metadata->>'applicationFeeAmount')::numeric,
               payment.fee_amount)>0
             FROM finance.payments payment
             WHERE payment.id=command.payment_id AND payment.property_id=command.property_id),false)
             AS has_application_fee
         FROM finance.card_refund_commands command WHERE id=$1 FOR UPDATE OF command SKIP LOCKED`,
        [commandId],
      )
    ).rows[0];
    if (!command || command.status !== "pending") {
      await client.query("COMMIT");
      return command ? (command.status as "succeeded" | "failed") : "busy";
    }
    // A retry waits for its time, whoever asks: right after a lost answer, Stripe may still be
    // making the refund and not list it yet, and a create then would make a second one.
    if (command.waiting) {
      await client.query("COMMIT");
      return "pending";
    }
    const lookup = { listed: false, refused: false };
    const earlier = (
      await client.query<{ id: string }>(
        "SELECT id FROM finance.card_refund_commands WHERE payment_id=$1 AND property_id=$2 AND id<>$3",
        [command.payment_id, command.property_id, command.id],
      )
    ).rows.map((row) => row.id);
    let refund: StripeBookingRefund | undefined;
    try {
      refund = await findOrCreateRefund(client, provider, command, lookup, earlier);
    } catch (error) {
      // Once Stripe has the refund, it is followed to the end. One Stripe confirms it never made
      // (the list answered without it, then Stripe refused the create) is given up after
      // MAX_ATTEMPTS, with an audit event; a lost answer is never given up on, and is asked about
      // again only after LOST_ANSWER_WAIT_MINUTES. Another live refund of the payment at Stripe
      // stops this one at once.
      const attempts = command.attempts + 1,
        blocked = error instanceof RefundAlreadyAtStripe,
        giveUp =
          blocked ||
          (!command.provider_refund_id &&
            lookup.listed &&
            lookup.refused &&
            attempts >= MAX_ATTEMPTS);
      await client.query(
        `UPDATE finance.card_refund_commands SET attempts=$2,failure_reason=$3,updated_at=clock_timestamp(),
           next_attempt_at=clock_timestamp()+make_interval(mins=>$4),
           status=CASE WHEN $5 THEN 'failed' ELSE status END,
           settled_at=CASE WHEN $5 THEN clock_timestamp() END
         WHERE id=$1`,
        [
          command.id,
          attempts,
          reason(error),
          Math.max(
            Math.min(2 ** command.attempts, 60),
            lookup.refused ? 0 : LOST_ANSWER_WAIT_MINUTES,
          ),
          giveUp,
        ],
      );
      if (giveUp) {
        await audit(client, command, "finance.card_refund_failed", {
          refundId: null,
          status: "failed",
        });
        warnFailed(command, reason(error), blocked);
      }
      await client.query("COMMIT");
      return giveUp ? "failed" : "pending";
    }
    if (refund.status !== "succeeded") {
      const result =
        refund.status === "failed" || refund.status === "canceled"
          ? await failRefund(client, command, refund)
          : await keepPending(client, command, refund);
      await client.query("COMMIT");
      return result;
    }
    // The money moved: if recording it fails, keep the refund id and retry later, never in a loop.
    await client.query("SAVEPOINT settle_refund");
    try {
      await settleRefund(client, command, refund);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT settle_refund");
      await client.query(
        `UPDATE finance.card_refund_commands SET provider_refund_id=$2,provider_status=$3,attempts=attempts+1,
           failure_reason=$4,updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()+make_interval(mins=>$5)
         WHERE id=$1`,
        [
          command.id,
          refund.refundId,
          refund.status,
          `settlement: ${reason(error)}`,
          Math.min(2 ** command.attempts, 60),
        ],
      );
      await client.query("COMMIT");
      throw new Error(
        `Pricing card refund ${command.id} succeeded at Stripe but couldn't be recorded`,
        {
          cause: error,
        },
      );
    }
    await client.query("COMMIT");
    return "succeeded";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** After a cancel commits: ask Stripe now, but answer the guest or the hotel within `waitMs`. A
 * slower refund carries on in the background, and the 60-second sweep retries anything left. */
export async function executePricingCardRefundSoon(
  pool: Pick<Pool, "connect">,
  provider: StripeBookingPaymentProvider,
  commandId: string,
  waitMs = 8_000,
): Promise<"succeeded" | "pending" | "failed" | "busy"> {
  const run = executePricingCardRefund(pool, provider, commandId).catch((error: unknown) => {
    console.warn("Pricing card refund left to the sweep.", {
      commandId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "pending" as const;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), waitMs);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stripe errors before a refund Stripe never made stops being retried (about a day with the
 * backoff). */
export const MAX_ATTEMPTS = 30;

/** After a lost answer, Stripe has long finished the create (or never got it) before it is asked
 * again, so the list then shows any refund it made. */
export const LOST_ANSWER_WAIT_MINUTES = 5;

/** A Stripe answer that the refund was refused (4xx), not one that may have been lost. */
const definiteRefusal = (error: unknown) => {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429
  );
};

/** Another refund of the same payment is live at Stripe: none may be made next to it. */
class RefundAlreadyAtStripe extends Error {}

async function findOrCreateRefund(
  client: PoolClient,
  provider: StripeBookingPaymentProvider,
  command: Command,
  lookup: { listed: boolean; refused: boolean },
  /** The payment's other refund commands: a retry follows one Stripe made after all. */
  earlier: readonly string[],
) {
  let refund: StripeBookingRefund;
  if (command.provider_refund_id)
    refund = await provider.retrieveRefund(
      command.provider_refund_id,
      command.provider_account_ref,
    );
  else {
    // Stripe forgets idempotency keys after 24 hours: look for this command's refund first.
    const listed = await provider.listRefunds(
      command.provider_payment_intent_id,
      command.provider_account_ref,
    );
    lookup.listed = true;
    // The command row records that Stripe's list answered before the create is asked. This
    // statement also keeps the open transaction from sitting idle across two Stripe calls in a
    // row (up to 60 s), which a 60 s idle-in-transaction limit would cut (VAY-2297).
    await client.query(
      "UPDATE finance.card_refund_commands SET updated_at=clock_timestamp() WHERE id=$1",
      [command.id],
    );
    // This command's own refund first. Otherwise the one live refund an earlier command made after
    // all (its answer was lost) is this retry's refund, when it is for the same amount. Any other
    // live refund, one made in Stripe's dashboard too, stops this one: the guest is never refunded
    // twice.
    const own = listed.find((candidate) => candidate.commandId === command.id);
    const others = own
      ? []
      : listed.filter(
          (candidate) => candidate.status !== "failed" && candidate.status !== "canceled",
        );
    const previous = others[0];
    if (
      others.length > 1 ||
      (previous &&
        (previous.commandId === null ||
          !earlier.includes(previous.commandId) ||
          previous.amountMinor !== Number(command.amount_minor)))
    )
      throw new RefundAlreadyAtStripe("Another refund of this payment is already at Stripe.");
    const found = own ?? previous ?? null;
    if (found) refund = found;
    else
      try {
        refund = await provider.createRefund({
          paymentIntentId: command.provider_payment_intent_id,
          providerAccountRef: command.provider_account_ref,
          amountMinor: Number(command.amount_minor),
          refundApplicationFee: command.has_application_fee,
          commandId: command.id,
          propertyId: command.property_id,
          bookingReference: command.booking_reference,
          // Stripe replays a key's first answer, errors included, for 24 hours: a retry after an
          // error needs its own key. The list above already rules out a second refund.
          idempotencyKey: command.attempts
            ? `${command.idempotency_key}:attempt-${command.attempts}`
            : command.idempotency_key,
        });
      } catch (error) {
        // Only a definite refusal counts toward giving up; a lost answer may be a refund Stripe made.
        lookup.refused = definiteRefusal(error);
        throw error;
      }
  }
  if (
    refund.paymentIntentId !== command.provider_payment_intent_id ||
    refund.amountMinor !== Number(command.amount_minor) ||
    refund.currency !== command.currency ||
    (refund.commandId !== null &&
      refund.commandId !== command.id &&
      !earlier.includes(refund.commandId))
  )
    throw new Error("Stripe answered with a refund for another command.");
  return refund;
}

async function keepPending(client: PoolClient, command: Command, refund: StripeBookingRefund) {
  await client.query(
    `UPDATE finance.card_refund_commands SET provider_refund_id=$2,provider_status=$3,attempts=attempts+1,
       updated_at=clock_timestamp(),next_attempt_at=clock_timestamp()+make_interval(mins=>$4)
     WHERE id=$1`,
    [command.id, refund.refundId, refund.status, Math.min(2 ** command.attempts, 60)],
  );
  return "pending" as const;
}

async function failRefund(client: PoolClient, command: Command, refund: StripeBookingRefund) {
  await client.query(
    `UPDATE finance.card_refund_commands SET status='failed',provider_refund_id=$2,provider_status=$3,
       failure_reason=$4,settled_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE id=$1`,
    [command.id, refund.refundId, refund.status, refund.failureReason ?? refund.status],
  );
  await audit(client, command, "finance.card_refund_failed", refund);
  warnFailed(command, refund.failureReason ?? refund.status);
  return "failed" as const;
}

/** The refund is money now: the card payment records it, a refund payment row corrects it, and
 * the booking says refunded when nothing paid is left (as manual refunds do). */
async function settleRefund(client: PoolClient, command: Command, refund: StripeBookingRefund) {
  await applyCardRefundMoney(client, {
    propertyId: command.property_id,
    guestBookingId: command.guest_booking_id,
    paymentId: command.payment_id,
    amount: command.amount,
    currency: command.currency,
    providerRefundId: refund.refundId,
    providerPaymentIntentId: command.provider_payment_intent_id,
    sourcePaymentId: `pricing-card-refund:${command.id}`,
    idempotencyKey: `${command.idempotency_key}:settlement`,
    ledgerSourceKey: `refund:${command.id}`,
    metadata: { commandId: command.id, requestedBy: command.requested_by },
  });
  await client.query(
    `UPDATE finance.card_refund_commands SET status='succeeded',provider_refund_id=$2,provider_status=$3,
       failure_reason=NULL,settled_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE id=$1`,
    [command.id, refund.refundId, refund.status],
  );
  await audit(client, command, "finance.card_refund", refund);
  return "succeeded" as const;
}

/** A card refund Stripe made, as money, inside the caller's transaction: the card payment records
 * it (never above what was paid), a refund payment row corrects it, the booking says refunded
 * when nothing paid is left, and a vayada Payment charge's hotel is owed that much less (the plan's
 * fee on it comes back, the vayada Payment fee doesn't). Vayada's own refund commands and refunds
 * made in Stripe's dashboard (VAY-2442) both settle here. */
export async function applyCardRefundMoney(
  client: Pick<PoolClient, "query">,
  input: {
    propertyId: string;
    guestBookingId: string;
    paymentId: string;
    amount: string;
    currency: string;
    providerRefundId: string;
    providerPaymentIntentId: string;
    sourcePaymentId: string;
    idempotencyKey: string;
    ledgerSourceKey: string;
    metadata: Record<string, unknown>;
  },
): Promise<"refunded" | "partially_refunded"> {
  const payment = (
    await client.query(
      `SELECT amount::text AS amount,refunded_amount::text AS refunded,organization_id,provider_account_id,
         payment_metadata->>'chargeType' AS charge_type,
         payment_metadata->>'platformFeeAmount' AS platform_fee_amount,
         COALESCE(payment_metadata->>'livemode'='true',false) AS livemode
       FROM finance.payments WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [input.paymentId, input.propertyId],
    )
  ).rows[0];
  const cents = (value: string) => BigInt(value.replace(".", ""));
  const refunded = cents(payment.refunded) + cents(input.amount);
  if (refunded > cents(payment.amount)) throw new Error("A card refund exceeds its payment.");
  const status = refunded === cents(payment.amount) ? "refunded" : "partially_refunded";
  await client.query(
    `UPDATE finance.payments SET refunded_amount=refunded_amount+$3::numeric,status=$4,updated_at=clock_timestamp()
     WHERE id=$1 AND property_id=$2`,
    [input.paymentId, input.propertyId, input.amount, status],
  );
  await client.query(
    `INSERT INTO finance.payments
       (property_id,organization_id,guest_booking_id,provider_account_id,source_system,source_payment_id,
        idempotency_key,payment_kind,payment_method,status,amount,net_amount,refunded_amount,currency,
        provider_transaction_id,provider_payment_intent_id,payment_metadata,visibility_class,paid_at)
     VALUES ($1,$2,$3,$4,'finance',$5,$6,'refund','card','refunded',$7::numeric,-$7::numeric,$7::numeric,$8,
       $9,$10,$11::jsonb,'pms_finance',clock_timestamp())`,
    [
      input.propertyId,
      payment.organization_id,
      input.guestBookingId,
      payment.provider_account_id,
      input.sourcePaymentId,
      input.idempotencyKey,
      input.amount,
      input.currency,
      input.providerRefundId,
      input.providerPaymentIntentId,
      JSON.stringify({
        contractVersion: "finance-card-refund.v1",
        correctsPaymentEvidenceId: input.paymentId,
        ...input.metadata,
        resultStatus: status,
      }),
    ],
  );
  // A part refund leaves the stay paid, or partly paid when a deposit was taken (VAY-2205).
  const bookingStatus = (
    await client.query(
      `UPDATE booking.guest_bookings
       SET payment_status=CASE WHEN $3 THEN 'refunded' ELSE payment_status END,updated_at=clock_timestamp()
       WHERE id=$1 AND property_id=$2 RETURNING payment_status`,
      [input.guestBookingId, input.propertyId, status === "refunded"],
    )
  ).rows[0]?.payment_status;
  // PMS lists read the summary; a stay without one has nothing to update.
  await client.query(
    `UPDATE booking.direct_booking_summary_read_model SET payment_status=$2,projected_at=clock_timestamp()
     WHERE guest_booking_id=$1`,
    [input.guestBookingId, bookingStatus],
  );
  if (payment.charge_type === "vayada_payment")
    await recordVayadaPaymentRefund(client, {
      propertyId: input.propertyId,
      guestBookingId: input.guestBookingId,
      paymentId: input.paymentId,
      sourceKey: input.ledgerSourceKey,
      currency: input.currency,
      paymentAmount: payment.amount,
      platformFeeAmount: requiredPlatformFee(payment.platform_fee_amount),
      refundAmount: input.amount,
      livemode: payment.livemode === true,
    });
  return status;
}

/** Every vayada Payment charge records the plan's fee (P3): a missing one is an error, never 0. */
function requiredPlatformFee(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d{2}$/.test(value))
    throw new Error("vayada Payment charge has no recorded plan fee.");
  return value;
}

/** A guest who isn't refunded needs a person: the log line carries ids only, no guest data. */
function warnFailed(command: Command, why: string, blocked = false) {
  const message = blocked
    ? "Pricing card refund stopped; another refund of this payment is at Stripe. Check it there before refunding the guest."
    : "Pricing card refund failed; the hotel must refund the guest another way.";
  console.warn(message, {
    commandId: command.id,
    propertyId: command.property_id,
    guestBookingId: command.guest_booking_id,
    reason: why,
  });
}

async function audit(
  client: PoolClient,
  command: Command,
  action: string,
  refund: Pick<StripeBookingRefund, "status"> & { refundId: string | null },
) {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,
        target_resource_type,target_resource_id,redacted_payload,audit_metadata,retention_class,privacy_scope)
     VALUES ($1,'finance',$2,clock_timestamp(),'property',$3,'system','finance','payment',$4,$5::jsonb,$6::jsonb,
       'financial','confidential')
     ON CONFLICT DO NOTHING`,
    [
      `${action}.${command.id}.v1`,
      action,
      command.property_id,
      command.payment_id,
      JSON.stringify({ amount: command.amount, currency: command.currency, status: refund.status }),
      JSON.stringify({
        commandId: command.id,
        providerRefundId: refund.refundId,
        requestedBy: command.requested_by,
      }),
    ],
  );
}

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : "Stripe refund failed").slice(0, 500);

/** Retries due refunds: commands whose Stripe call failed or whose refund is still pending at
 * Stripe. Each runs in its own transaction; one bad command doesn't stop the others. */
export async function runPendingPricingCardRefunds(
  pool: Pick<Pool, "connect" | "query">,
  provider: StripeBookingPaymentProvider,
  limit = 20,
): Promise<{ attempted: number; failed: number; errors: number }> {
  const due = (
    await pool.query(
      `SELECT id FROM finance.card_refund_commands WHERE status='pending' AND next_attempt_at<=now()
       ORDER BY next_attempt_at,id LIMIT $1`,
      [limit],
    )
  ).rows as { id: string }[];
  let errors = 0,
    failed = 0;
  for (const { id } of due) {
    try {
      if ((await executePricingCardRefund(pool, provider, id)) === "failed") failed += 1;
    } catch {
      errors += 1;
    }
  }
  return { attempted: due.length, failed, errors };
}
