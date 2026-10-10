import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import type { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "./stripeBookingPayments.js";
import {
  stripeAmountDecimal,
  stripeAmountMinor,
  stripeApplicationFeeMinor,
} from "./stripeMoney.js";

type Current = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
type Finance = NonNullable<Awaited<ReturnType<typeof lockFinancePricingAcceptanceTerms>>>;

/** How long an accepted card booking holds its rooms while the guest pays
 * (`booking_metadata.pendingExpiresAt`, read by the pending-booking expiry sweep). */
export const PRICING_CARD_PAYMENT_MINUTES = 30;

const fail = (): never => {
  throw new Error("Pricing card payment is unavailable");
};

/** Card quotes this path can execute: fully paid online, instant (captured at once) or a
 * request (authorised now, captured when the hotel accepts). Quotes with an amount due at the
 * property stay pay-at-property until partially paid bookings are supported downstream
 * (balance collection, host cancel, PMS handoff). */
export function pricingCardQuoteSupported(quote: Current["quote"]): boolean {
  const { totalMinor, dueNowMinor, dueLaterMinor } = quote.evidence;
  return (
    quote.paymentMethod === "card" &&
    (quote.acceptanceMode === "instant" || quote.acceptanceMode === "request") &&
    /^[1-9][0-9]*$/.test(dueNowMinor) &&
    dueNowMinor === totalMinor &&
    dueLaterMinor === "0"
  );
}

/** Stable booking id for a card acceptance command: a retry after a rollback sends Stripe the
 * same idempotency key with the same booking reference instead of a conflicting request. */
export function pricingCardBookingId(propertyId: string, requestId: string): string {
  const h = createHash("sha256")
    .update(`pricing-card-booking:${propertyId}:${requestId}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Pricing minor units → two-decimal amount string, as the booking draft stores totals. */
function pricingMinorDecimal(minor: string, currency: string): string {
  const scale = pricingCurrencyScale(currency);
  if (scale === null) return fail();
  const numerator = BigInt(minor) * 100n,
    unit = 10n ** BigInt(scale);
  if (numerator % unit !== 0n || numerator / unit > 999999999999999n) return fail();
  const cents = numerator / unit;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Stripe idempotency key for the acceptance command; replays reuse the same intent. */
export function pricingCardPaymentIdempotencyKey(propertyId: string, requestId: string): string {
  return `pricing-card:${propertyId}:${createHash("sha256").update(requestId).digest("hex")}`;
}

/** After the card acceptance is stored (booking `pending_payment`): create the PaymentIntent for the amount due now on the
 * hotel's connected Stripe account and record it as `requires_action`. The Stripe call runs
 * inside the caller's transaction, as the legacy checkout does; a rollback leaves at most an
 * unconfirmed intent, and a retry (same request, same booking id) gets the same intent back. */
export async function startPricingCardPayment(
  client: PoolClient,
  provider: StripeBookingPaymentProvider,
  input: {
    slug: unknown;
    current: Current;
    finance: Finance;
    bookingId: string;
    publicReference: string;
    requestId: string;
    occurredAt: string;
  },
): Promise<StripeBookingPaymentIntent> {
  const scope = await lockPublicPricingAuthority(client, input.slug);
  const quote = input.current.quote;
  if (
    !scope ||
    !isDeepStrictEqual(scope, input.current.scope) ||
    !isDeepStrictEqual(scope, input.finance.scope) ||
    !pricingCardQuoteSupported(quote)
  )
    return fail();
  const account = (
    await client.query(
      `SELECT account.id,account.provider_account_id
      FROM finance.payment_settings settings
      JOIN finance.payment_provider_accounts account
        ON account.id=settings.provider_account_id AND account.property_id=settings.property_id
      WHERE settings.property_id=$1 AND settings.payments_enabled
        AND 'card'=ANY(settings.accepted_methods) AND account.provider='stripe'
      FOR SHARE OF settings,account`,
      [scope.propertyId],
    )
  ).rows[0];
  if (
    !account ||
    typeof account.provider_account_id !== "string" ||
    !account.provider_account_id.startsWith("acct_")
  )
    return fail();
  const currency = quote.stay.currency;
  const amount = pricingMinorDecimal(quote.evidence.dueNowMinor, currency);
  let amountMinor: number, feeMinor: number;
  try {
    amountMinor = stripeAmountMinor(amount, currency);
    feeMinor = stripeApplicationFeeMinor(
      amountMinor,
      input.finance.billingPlanSnapshot,
      input.finance.commissionTermsSnapshot.bookingEngineFeePercent,
    );
  } catch {
    return fail();
  }
  const idempotencyKey = pricingCardPaymentIdempotencyKey(scope.propertyId, input.requestId);
  // A request only authorises the card; the hotel's acceptance captures it.
  const captureMethod = quote.acceptanceMode === "request" ? "manual" : "automatic";
  const intent = await provider.createPaymentIntent({
    propertyId: scope.propertyId,
    bookingReference: input.publicReference,
    providerAccountRef: account.provider_account_id,
    amountMinor,
    applicationFeeAmountMinor: feeMinor,
    currency,
    captureMethod,
    idempotencyKey,
  });
  if (
    !intent.clientSecret ||
    intent.amountMinor !== amountMinor ||
    intent.currency.toUpperCase() !== currency.toUpperCase()
  )
    return fail();
  const inserted = await client.query(
    `INSERT INTO finance.payments (
       property_id,guest_booking_id,provider_account_id,source_system,idempotency_key,payment_kind,
       payment_method,status,amount,fee_amount,net_amount,refunded_amount,currency,
       provider_payment_intent_id,processor_fee_breakdown,payment_metadata,visibility_class,created_at,updated_at
     ) VALUES ($1,$2,$3,'finance',$4,'full','card','requires_action',$5::numeric,$6::numeric,$7::numeric,0,$8,
       $9,$10::jsonb,$11::jsonb,'pms_finance',$12::timestamptz,$12::timestamptz)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
    [
      scope.propertyId,
      input.bookingId,
      account.id,
      idempotencyKey,
      amount,
      stripeAmountDecimal(feeMinor, currency),
      stripeAmountDecimal(amountMinor - feeMinor, currency),
      currency,
      intent.paymentIntentId,
      { contractVersion: "stripe-direct-charge.v1", status: "pending", currency },
      {
        providerStatus: intent.status,
        captureMethod,
        acceptanceMode: quote.acceptanceMode,
        bookingReference: input.publicReference,
        pricingQuoteId: quote.quoteId,
        billingPlan: input.finance.billingPlanSnapshot,
        platformFeePercent:
          input.finance.billingPlanSnapshot === "commission"
            ? input.finance.commissionTermsSnapshot.bookingEngineFeePercent
            : 0,
        chargeType: "direct",
        applicationFeeAmount: stripeAmountDecimal(feeMinor, currency),
        applicationFeeCurrency: currency,
        reconciliationStatus: "pending",
      },
      input.occurredAt,
    ],
  );
  if (inserted.rowCount !== 1) return fail();
  const linked = await client.query(
    `UPDATE booking.guest_bookings SET active_card_payment_id=$3,
      booking_metadata=booking_metadata || $4::jsonb,updated_at=$5::timestamptz
    WHERE id=$1 AND property_id=$2 AND lifecycle_status='pending_payment' AND payment_status='unpaid'
      AND expected_payment_method='unknown' AND booking_metadata->>'paymentMethod'='card'
      AND active_card_payment_id IS NULL`,
    [
      input.bookingId,
      scope.propertyId,
      inserted.rows[0].id,
      { providerPaymentIntentId: intent.paymentIntentId },
      input.occurredAt,
    ],
  );
  if (
    linked.rowCount !== 1 ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, input.slug), scope)
  )
    return fail();
  return intent;
}

/** Replay of an accepted card quote. Null when the booking is not a card booking or is
 * already paid (the plain replay is right). While it awaits payment: the same PaymentIntent,
 * so the guest can finish paying. An expired or canceled card booking, or one awaiting payment
 * while card acceptance is switched off, is a conflict, never a success. */
export async function readPricingCardReplay(
  client: PoolClient,
  provider: StripeBookingPaymentProvider | undefined,
  slug: unknown,
  replay: { bookingId: string; bookingReference: string },
) {
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return fail();
  const row = (
    await client.query(
      `SELECT booking.lifecycle_status,booking.payment_status,
        booking.booking_metadata->>'paymentMethod' AS method,
        booking.booking_metadata->>'pendingExpiresAt' AS deadline,
        payment.status AS payment_row_status,payment.provider_payment_intent_id AS intent,
        account.provider_account_id AS account
      FROM booking.guest_bookings booking
      LEFT JOIN finance.payments payment ON payment.id=booking.active_card_payment_id
        AND payment.property_id=booking.property_id
      LEFT JOIN finance.payment_provider_accounts account ON account.id=payment.provider_account_id
        AND account.property_id=payment.property_id
      WHERE booking.id=$1 AND booking.property_id=$2`,
      [replay.bookingId, scope.propertyId],
    )
  ).rows[0];
  if (!row || row.method !== "card") return null;
  if (row.lifecycle_status === "confirmed" && row.payment_status !== "unpaid") return null;
  if (
    !provider ||
    row.lifecycle_status !== "pending_payment" ||
    row.payment_status !== "unpaid" ||
    row.payment_row_status !== "requires_action" ||
    typeof row.intent !== "string" ||
    typeof row.account !== "string"
  )
    throw new Error("Booking acceptance expired or unavailable");
  const intent = await provider.retrievePaymentIntent(row.intent, row.account);
  if (
    !intent.clientSecret ||
    intent.paymentIntentId !== row.intent ||
    ![
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
      "processing",
      "succeeded",
    ].includes(intent.status)
  )
    throw new Error("Booking acceptance expired or unavailable");
  return {
    kind: "payment_required" as const,
    bookingId: replay.bookingId,
    bookingReference: replay.bookingReference,
    replayed: true as const,
    payment: {
      provider: "stripe" as const,
      clientSecret: intent.clientSecret,
      stripeAccountId: row.account,
      paymentIntentId: row.intent,
      expiresAt: row.deadline,
    },
  };
}
