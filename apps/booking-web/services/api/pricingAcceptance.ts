import {
  isManualPricingPaymentMethod,
  parsePublicQuoteGuestDisclosure,
  type PublicBookingQuote,
  type PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import {
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
} from "@/lib/storage/bookingDraft";
import { deviceTimeOf, serverNow } from "@/lib/serverClock";
import { ApiError, bookingWebPublic } from "./client";

export type PricingAcceptanceGuest = Readonly<{
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  countryCode?: string | null;
  arrivalTime?: string | null;
  specialRequests?: string | null;
}>;

export type PricingAcceptanceResult =
  | Readonly<{
      kind: "accepted";
      bookingId: string;
      bookingReference: string;
      acceptanceId: string;
      acceptedAt: string;
      checkedAt: string;
    }>
  | Readonly<{
      /** A request: the booking waits for the hotel, which answers before the deadline. */
      kind: "requested";
      bookingId: string;
      bookingReference: string;
      acceptanceId: string;
      acceptedAt: string;
      hostResponseDeadlineAt: string;
      checkedAt: string;
    }>
  | Readonly<{
      kind: "replayed";
      bookingId: string;
      bookingReference: string;
      replayed: true;
    }>;

/** A bank-transfer or PayPal booking held until the guest pays the hotel (VAY-2139). The token
 * opens the bank details or PayPal email on the confirmation page. */
export type PricingManualPaymentPending = Readonly<{
  kind: "payment_pending";
  bookingId: string;
  bookingReference: string;
  payment: Readonly<{
    method: "bank_transfer" | "paypal";
    amountMinor: string;
    currency: string;
    deadlineAt: string;
  }>;
  confirmationToken: string;
}>;

/** An accepted card quote whose booking waits for the guest's card payment. */
export type PricingCardPaymentRequired = Readonly<{
  kind: "payment_required";
  bookingId: string;
  bookingReference: string;
  requestId: string;
  payment: Readonly<{
    provider: "stripe";
    clientSecret: string;
    /** The hotel's connected account; null for vayada Payment, which charges on the Stripe
     * account of `publishableKey` (VAY-2442). */
    stripeAccountId: string | null;
    publishableKey?: string;
    paymentIntentId: string;
    expiresAt: string;
  }>;
}>;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const bookingReference = (value: unknown): value is string =>
  typeof value === "string" && /^VAY-[A-Z0-9]{6,32}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function parseCardPaymentRequired(
  value: unknown,
  requestId: string,
): PricingCardPaymentRequired | null {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { kind?: unknown }).kind !== "payment_required"
  )
    return null;
  const v = value as Record<string, unknown>;
  const keys = ["provider", "clientSecret", "stripeAccountId", "paymentIntentId", "expiresAt"];
  const payment =
    exact(v.payment, keys) || exact(v.payment, [...keys, "publishableKey"]) ? v.payment : null;
  if (!payment) return null;
  // A hotel's connected account, or vayada Payment (VAY-2442): no account and the test-mode
  // publishable key of the Stripe account that takes the payment.
  const connect =
    !("publishableKey" in payment) &&
    typeof payment.stripeAccountId === "string" &&
    /^acct_[A-Za-z0-9]+$/.test(payment.stripeAccountId);
  const vayada =
    payment.stripeAccountId === null &&
    typeof payment.publishableKey === "string" &&
    /^pk_test_[A-Za-z0-9]+$/.test(payment.publishableKey);
  if (
    !uuid(v.bookingId) ||
    !bookingReference(v.bookingReference) ||
    !(connect || vayada) ||
    payment.provider !== "stripe" ||
    typeof payment.clientSecret !== "string" ||
    !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(payment.clientSecret) ||
    typeof payment.paymentIntentId !== "string" ||
    !payment.clientSecret.startsWith(`${payment.paymentIntentId}_secret_`) ||
    !iso(payment.expiresAt)
  )
    return null;
  return {
    kind: "payment_required",
    bookingId: v.bookingId,
    bookingReference: v.bookingReference,
    requestId,
    payment: {
      provider: "stripe",
      clientSecret: payment.clientSecret,
      stripeAccountId: connect ? (payment.stripeAccountId as string) : null,
      ...(vayada ? { publishableKey: payment.publishableKey as string } : {}),
      paymentIntentId: payment.paymentIntentId,
      expiresAt: payment.expiresAt,
    },
  };
}

function parseManualPaymentPending(value: unknown): PricingManualPaymentPending | null {
  const keys = ["kind", "bookingId", "bookingReference", "payment", "confirmationToken"];
  const fresh = ["acceptanceId", "acceptedAt", "checkedAt", "confirmationTokenExpiresAt"];
  const replay = ["replayed", "confirmationTokenExpiresAt"];
  if (
    !(exact(value, [...keys, ...fresh]) || exact(value, [...keys, ...replay])) ||
    value.kind !== "payment_pending" ||
    !uuid(value.bookingId) ||
    !bookingReference(value.bookingReference) ||
    typeof value.confirmationToken !== "string" ||
    !/^[A-Za-z0-9_-]{40,80}$/.test(value.confirmationToken) ||
    !exact(value.payment, ["method", "amountMinor", "currency", "deadlineAt"]) ||
    (value.payment.method !== "bank_transfer" && value.payment.method !== "paypal") ||
    typeof value.payment.amountMinor !== "string" ||
    !/^[1-9][0-9]*$/.test(value.payment.amountMinor) ||
    typeof value.payment.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.payment.currency) ||
    !iso(value.payment.deadlineAt)
  )
    return null;
  const payment = value.payment;
  return {
    kind: "payment_pending",
    bookingId: value.bookingId,
    bookingReference: value.bookingReference,
    payment: {
      method: payment.method as "bank_transfer" | "paypal",
      amountMinor: payment.amountMinor as string,
      currency: payment.currency as string,
      deadlineAt: payment.deadlineAt as string,
    },
    confirmationToken: value.confirmationToken,
  };
}

function parsePricingAcceptanceResult(value: unknown): PricingAcceptanceResult | null {
  if (
    exact(value, ["kind", "bookingId", "bookingReference", "replayed"]) &&
    value.kind === "replayed" &&
    uuid(value.bookingId) &&
    bookingReference(value.bookingReference) &&
    value.replayed === true
  )
    return structuredClone(value) as PricingAcceptanceResult;
  if (
    exact(value, [
      "kind",
      "bookingId",
      "bookingReference",
      "acceptanceId",
      "acceptedAt",
      "checkedAt",
    ]) &&
    value.kind === "accepted" &&
    uuid(value.bookingId) &&
    bookingReference(value.bookingReference) &&
    uuid(value.acceptanceId) &&
    iso(value.acceptedAt) &&
    iso(value.checkedAt) &&
    value.checkedAt >= value.acceptedAt
  )
    return structuredClone(value) as PricingAcceptanceResult;
  if (
    exact(value, [
      "kind",
      "bookingId",
      "bookingReference",
      "acceptanceId",
      "acceptedAt",
      "hostResponseDeadlineAt",
      "checkedAt",
    ]) &&
    value.kind === "requested" &&
    uuid(value.bookingId) &&
    bookingReference(value.bookingReference) &&
    uuid(value.acceptanceId) &&
    iso(value.acceptedAt) &&
    iso(value.checkedAt) &&
    iso(value.hostResponseDeadlineAt) &&
    value.checkedAt >= value.acceptedAt &&
    value.hostResponseDeadlineAt > value.acceptedAt
  )
    return structuredClone(value) as PricingAcceptanceResult;
  return null;
}

const optional = (value: string | null | undefined) => value?.trim() || null;

/** Quotes paid at the property (instant, or a request the hotel confirms), or instant and paid in
 * full online by card (the answer is then payment_required). The server re-reads and validates
 * every quote, policy and finance owner. */
export async function acceptPricingQuote(
  slug: string,
  quote: PublicBookingQuote,
  disclosure: PublicQuoteGuestDisclosure,
  guest: PricingAcceptanceGuest,
  signal?: AbortSignal,
  mode: "fresh" | "uncertain-retry" = "fresh",
): Promise<PricingAcceptanceResult | PricingCardPaymentRequired | PricingManualPaymentPending> {
  const verifiedDisclosure = parsePublicQuoteGuestDisclosure(disclosure, quote);
  if (
    !pricingQuoteBookableOnline(quote) ||
    !verifiedDisclosure ||
    (mode === "fresh" && Date.parse(quote.expiresAt) <= serverNow())
  )
    throw new Error("This price cannot be booked online. Please refresh the price.");

  const normalizedGuest = {
    firstName: guest.firstName.trim(),
    lastName: guest.lastName.trim(),
    email: guest.email.trim().toLowerCase(),
    phone: optional(guest.phone),
    countryCode: optional(guest.countryCode)?.toUpperCase() ?? null,
    arrivalTime: optional(guest.arrivalTime),
    specialRequests: optional(guest.specialRequests),
  };
  const acceptance = {
    accepted: true as const,
    quoteEvidenceId: verifiedDisclosure.quoteEvidenceId,
    guestPolicyEvidenceId: verifiedDisclosure.guestPolicyEvidenceId,
  };
  const identity = JSON.stringify([slug, quote.quoteId, acceptance, normalizedGuest]);
  const requestId = getCheckoutIdempotencyKey("pricing-acceptance", identity);
  const command = {
    version: "booking-quote-acceptance.v1" as const,
    requestId,
    quoteId: quote.quoteId,
    acceptance,
    guest: normalizedGuest,
  };

  let raw: unknown;
  try {
    raw = await bookingWebPublic.post<unknown>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quotes/${encodeURIComponent(quote.quoteId)}/accept`,
      command,
      { headers: { "Idempotency-Key": requestId }, signal, cache: "no-store" },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      expireCheckoutIdempotencyKeyAt(
        "pricing-acceptance",
        identity,
        new Date().toISOString(),
        requestId,
      );
    throw error;
  }
  signal?.throwIfAborted();
  const card = parseCardPaymentRequired(raw, requestId);
  // Keep the key while the card payment is open, so a retry returns the same payment.
  if (card) return card;
  const manual = parseManualPaymentPending(raw);
  if (manual) {
    expireCheckoutIdempotencyKeyAt(
      "pricing-acceptance",
      identity,
      new Date(deviceTimeOf(quote.expiresAt)).toISOString(),
      requestId,
    );
    return manual;
  }
  const result = parsePricingAcceptanceResult(raw);
  if (!result) throw new Error("The booking confirmation could not be verified. Please try again.");
  expireCheckoutIdempotencyKeyAt(
    "pricing-acceptance",
    identity,
    new Date(deviceTimeOf(quote.expiresAt)).toISOString(),
    requestId,
  );
  return result;
}

/** Quotes this page can book, instantly or as a request the hotel confirms: paid at the
 * property, or by card now (a request only authorises the card), with any rest paid at the
 * property: a deposit's remainder or the hotel's own fees (VAY-2205). */
export function pricingQuoteBookableOnline(quote: PublicBookingQuote): boolean {
  if (quote.paymentMethod === "pay_at_property")
    return quote.dueNowMinor === "0" && quote.dueLaterMinor === quote.totalMinor;
  if (quote.paymentMethod === "card")
    return (
      quote.dueNowMinor !== "0" &&
      BigInt(quote.dueNowMinor) + BigInt(quote.dueLaterMinor) === BigInt(quote.totalMinor)
    );
  // Bank transfer and PayPal are paid in full before the deadline.
  return (
    isManualPricingPaymentMethod(quote.paymentMethod) &&
    quote.dueNowMinor === quote.totalMinor &&
    quote.dueLaterMinor === "0"
  );
}

export type PricingCardPaymentResult =
  | Readonly<{
      kind: "accepted";
      bookingId: string;
      bookingReference: string;
      replayed: boolean;
    }>
  | Readonly<{
      /** A card request: authorised, not charged; the hotel answers before the deadline. */
      kind: "requested";
      bookingId: string;
      bookingReference: string;
      replayed: boolean;
      hostResponseDeadlineAt: string;
    }>;

/** After Stripe confirmed the card in the browser: ask the server to confirm the booking.
 * 409 PAYMENT_PENDING means Stripe has not reported the payment yet; retry shortly. */
export async function completePricingCardPayment(
  slug: string,
  quoteId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<PricingCardPaymentResult> {
  const raw = await bookingWebPublic.post<unknown>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quotes/${encodeURIComponent(quoteId)}/accept/payment`,
    {},
    { headers: { "Idempotency-Key": requestId }, signal, cache: "no-store" },
  );
  const v = raw as Record<string, unknown> | null;
  if (
    !v ||
    (v.kind !== "accepted" && v.kind !== "requested") ||
    !uuid(v.bookingId) ||
    !bookingReference(v.bookingReference) ||
    typeof v.replayed !== "boolean" ||
    (v.kind === "requested" && !iso(v.hostResponseDeadlineAt))
  )
    throw new Error("The booking confirmation could not be verified. Please try again.");
  return v.kind === "requested"
    ? {
        kind: "requested",
        bookingId: v.bookingId,
        bookingReference: v.bookingReference,
        replayed: v.replayed,
        hostResponseDeadlineAt: v.hostResponseDeadlineAt as string,
      }
    : {
        kind: "accepted",
        bookingId: v.bookingId,
        bookingReference: v.bookingReference,
        replayed: v.replayed,
      };
}
