import type { PricingPaymentMethod } from "./pricingPaymentMethods.js";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";

type Payment = ReplacementOfferTerms["payment"];
type CancellationKind = ReplacementOfferTerms["cancellation"]["kind"];

/** Paid before the stay: card when booking, bank transfer and PayPal before their deadline (VAY-2139). */
export const PREPAID_PRICING_PAYMENT_METHODS = ["card", "bank_transfer", "paypal"] as const;
export type PrepaidPricingPaymentMethod = (typeof PREPAID_PRICING_PAYMENT_METHODS)[number];

/** A rate's "Paid when booking" (VAY-2205, VAY-2282). It has no field of its own: the booking page already takes
 * nothing now for pay at property and everything now for the other methods, so the choice is read from the terms.
 * - nothing: pay at property only;
 * - full_stay: prepaid methods only;
 * - deposit: a percentage by card when booking, the rest at the property. */
export type PaidWhenBooking = "nothing" | "deposit" | "full_stay";
/** Stored terms can also hold what the choice never writes: pay at property together with a prepaid method (the
 * guest picks when to pay, as legacy hotels do), or no methods at all (rows from before VAY-2139). */
export type StoredPaidWhenBooking = PaidWhenBooking | "guest_chooses" | "not_set";

export function paidWhenBooking(payment: Payment): StoredPaidWhenBooking {
  if (payment.kind === "deposit") return "deposit";
  const methods = payment.acceptedMethods ?? [];
  if (!methods.length) return "not_set";
  if (!methods.includes("pay_at_property")) return "full_stay";
  return methods.length === 1 ? "nothing" : "guest_chooses";
}

/** Non-refundable stays are paid in advance, so they never pay nothing when booking (VAY-2280). */
export function paidWhenBookingChoices(cancellation: CancellationKind): readonly PaidWhenBooking[] {
  return cancellation === "non_refundable"
    ? ["deposit", "full_stay"]
    : ["nothing", "deposit", "full_stay"];
}

/** The payment a choice writes. Full stay keeps the given prepaid methods; a deposit is a whole percentage below
 * 100 (100% is Full stay). Null when the choice can't be written from the input. */
export function paymentForChoice(
  choice: PaidWhenBooking,
  input: { methods: readonly PricingPaymentMethod[]; depositPercent?: number },
): Payment | null {
  if (choice === "nothing") return { kind: "full", acceptedMethods: ["pay_at_property"] };
  if (choice === "deposit") {
    const percent = input.depositPercent;
    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 99)
      return null;
    return {
      kind: "deposit",
      basisPoints: percent * 100,
      balanceDaysBeforeArrival: 0,
      acceptedMethods: ["card"],
    };
  }
  const methods = PREPAID_PRICING_PAYMENT_METHODS.filter((method) =>
    input.methods.includes(method),
  );
  return methods.length ? { kind: "full", acceptedMethods: methods } : null;
}

/** A new rate's first choice from the ways the hotel can take now: a flexible rate is paid at the property when the
 * hotel takes that, every other rate in full when booking. Null when none fits. */
export function defaultPaidWhenBookingPayment(
  cancellation: CancellationKind,
  readyMethods: readonly PricingPaymentMethod[],
): Payment | null {
  return cancellation === "flexible" && readyMethods.includes("pay_at_property")
    ? paymentForChoice("nothing", { methods: readyMethods })
    : paymentForChoice("full_stay", { methods: readyMethods });
}

export type PricingPaymentWriteProblem =
  | "payment_methods_required"
  | "deposit_card_only"
  | "deposit_rest_at_property"
  | "deposit_below_full_stay";

/** Rules for a payment a hotel writes now (VAY-2205). Stored terms stay readable without them. */
export function pricingPaymentWriteProblem(payment: Payment): PricingPaymentWriteProblem | null {
  if (!payment.acceptedMethods?.length) return "payment_methods_required";
  if (payment.kind !== "deposit") return null;
  if (payment.acceptedMethods.length !== 1 || payment.acceptedMethods[0] !== "card")
    return "deposit_card_only";
  if (payment.balanceDaysBeforeArrival !== 0) return "deposit_rest_at_property";
  return payment.basisPoints < 10000 ? null : "deposit_below_full_stay";
}
