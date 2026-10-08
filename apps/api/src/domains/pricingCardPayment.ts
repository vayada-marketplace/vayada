import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
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

/** How long a card booking holds its rooms while the guest pays. The existing
 * expired-draft sweep reads `booking_metadata.draftExpiresAt`. */
export const PRICING_CARD_DRAFT_MINUTES = 30;

const fail = (): never => {
  throw new Error("Pricing card payment is unavailable");
};

/** Card quotes this path can execute: instant, online part due now, rest at the property. */
export function pricingCardQuoteSupported(quote: Current["quote"]): boolean {
  const { totalMinor, dueNowMinor, dueLaterMinor } = quote.evidence;
  return (
    quote.paymentMethod === "card" &&
    quote.acceptanceMode === "instant" &&
    /^[1-9][0-9]*$/.test(dueNowMinor) &&
    /^(0|[1-9][0-9]*)$/.test(dueLaterMinor) &&
    BigInt(dueNowMinor) + BigInt(dueLaterMinor) === BigInt(totalMinor)
  );
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

/** After stagePricingBookingDraft, on the same READ COMMITTED transaction: reserve the
 * quote's inventory and keep the booking a `draft` until Stripe reports the payment.
 * Nothing is confirmed, announced or handed to the PMS here. */
export async function stagePricingCardDraftHold(
  client: PoolClient,
  slug: unknown,
  current: Current,
  bookingId: string,
) {
  const scope = await lockPublicPricingAuthority(client, slug);
  const quote = current.quote;
  if (
    !scope ||
    !isDeepStrictEqual(scope, current.scope) ||
    current.kind !== "current_quote_price" ||
    scope.propertyId !== quote.stay.propertyId ||
    !pricingCardQuoteSupported(quote)
  )
    return fail();
  const booking = (
    await client.query(
      `SELECT lifecycle_status,payment_status,expected_payment_method,edit_revision,booking_metadata
      FROM booking.guest_bookings WHERE id=$1 AND property_id=$2 FOR UPDATE`,
      [bookingId, scope.propertyId],
    )
  ).rows[0];
  const metadata = booking?.booking_metadata;
  if (
    !booking ||
    booking.lifecycle_status !== "draft" ||
    booking.payment_status !== "unpaid" ||
    booking.expected_payment_method !== "card" ||
    booking.edit_revision !== 0 ||
    metadata?.targetSource !== "pricing_quote_draft" ||
    metadata.pricingQuoteId !== quote.quoteId ||
    metadata.paymentMethod !== "card" ||
    Object.hasOwn(metadata, "inventoryReservation")
  )
    return fail();
  const reserved = await reserveRevalidatedQuoteInventory(client, slug, current);
  if (!isDeepStrictEqual(reserved.quote, quote)) return fail();
  const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail();
  const occurredAt = now.toISOString();
  if (occurredAt < quote.evidence.issuedAt || occurredAt >= quote.evidence.expiresAt) return fail();
  const draftExpiresAt = new Date(
    now.getTime() + PRICING_CARD_DRAFT_MINUTES * 60 * 1000,
  ).toISOString();
  const updated = await client.query(
    `UPDATE booking.guest_bookings SET booking_metadata=booking_metadata || $3::jsonb,updated_at=$4::timestamptz
    WHERE id=$1 AND property_id=$2 AND lifecycle_status='draft' AND payment_status='unpaid'`,
    [
      bookingId,
      scope.propertyId,
      { inventoryReservation: reserved.bundle, draftExpiresAt },
      occurredAt,
    ],
  );
  if (
    updated.rowCount !== 1 ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)
  )
    return fail();
  return { bookingId, occurredAt, draftExpiresAt, inventoryReservation: reserved.bundle };
}

/** Stripe idempotency key for the acceptance command; replays reuse the same intent. */
export function pricingCardPaymentIdempotencyKey(propertyId: string, requestId: string): string {
  return `pricing-card:${propertyId}:${createHash("sha256").update(requestId).digest("hex")}`;
}

/** After stagePricingCardDraftHold: create the PaymentIntent for the amount due now on the
 * hotel's connected Stripe account and record it as `requires_action`. The Stripe call runs
 * inside the caller's transaction, as the legacy checkout does; a rollback leaves at most an
 * unconfirmed intent that the same idempotency key returns again. */
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
  const intent = await provider.createPaymentIntent({
    propertyId: scope.propertyId,
    bookingReference: input.publicReference,
    providerAccountRef: account.provider_account_id,
    amountMinor,
    applicationFeeAmountMinor: feeMinor,
    currency,
    captureMethod: "automatic",
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
        captureMethod: "automatic",
        acceptanceMode: "instant",
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
    WHERE id=$1 AND property_id=$2 AND lifecycle_status='draft' AND payment_status='unpaid'`,
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
