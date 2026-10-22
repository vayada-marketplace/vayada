import {
  isManualPricingPaymentMethod,
  pricingPaymentWriteProblem,
  type ManualPricingPaymentMethod,
  type PricingPaymentMethod,
  type ReplacementOfferTerms,
} from "@vayada/domain-booking";

/** VAY-2304: why a published rate isn't selling, and what fixes it. The vocabulary of
 * GET …/pricing-v2/not-selling (pricing-rates-not-selling.v1); keep it stable. */
export type PricingRateNotSellingReason =
  | "card_off"
  | "card_not_chosen"
  | "card_setup_incomplete"
  | "deposits_off"
  | "pay_at_property_off"
  | "no_payment_method";
export type PricingRateFix =
  | "turn_card_on"
  | "choose_card"
  | "finish_stripe_setup"
  | "allow_pay_at_property"
  | "change_rate_payment"
  | "turn_pay_at_property_on";

/** The booking page's own switches (REPLACEMENT_PRICING_*): card and deposits accepted, and which
 * of bank transfer and PayPal. */
export type PricingPaymentSwitches = Readonly<{
  card: boolean;
  deposits: boolean;
  manual: readonly ManualPricingPaymentMethod[];
}>;

/** What guests can pay with at the hotel now: Finance's ready methods, as the switches allow. */
export type PricingPaymentsNow = Readonly<{
  methods: readonly PricingPaymentMethod[];
  deposits: boolean;
}>;

export function pricingPaymentsNow(
  financeMethods: readonly PricingPaymentMethod[],
  switches: PricingPaymentSwitches,
): PricingPaymentsNow {
  return {
    methods: financeMethods.filter((method) =>
      method === "card"
        ? switches.card
        : isManualPricingPaymentMethod(method)
          ? switches.manual.includes(method)
          : true,
    ),
    deposits: switches.card && switches.deposits,
  };
}

/** Whether guests can pay this rate now, as a quote decides (publicPricingPaymentAmounts): a rate
 * paid in full by any method its terms accept that is ready, a deposit only by card, in its
 * supported shape, with deposits on. */
export function pricingRateSells(terms: ReplacementOfferTerms, now: PricingPaymentsNow): boolean {
  const accepted = terms.payment.acceptedMethods ?? [];
  if (terms.payment.kind === "deposit")
    return (
      now.deposits &&
      accepted.includes("card") &&
      now.methods.includes("card") &&
      pricingPaymentWriteProblem(terms.payment) === null
    );
  return terms.payment.kind === "full" && accepted.some((method) => now.methods.includes(method));
}

/** Card at the hotel now: ready, or the first thing missing as the hotel can act on it. */
export type PricingCardState = "ready" | "off" | "not_chosen" | "setup_incomplete";

const CARD: Record<
  Exclude<PricingCardState, "ready">,
  readonly [PricingRateNotSellingReason, PricingRateFix]
> = {
  off: ["card_off", "turn_card_on"],
  not_chosen: ["card_not_chosen", "choose_card"],
  setup_incomplete: ["card_setup_incomplete", "finish_stripe_setup"],
};

/** Why this rate isn't selling and its fixes, main fix first; null when it sells. */
export function pricingRateNotSelling(
  terms: ReplacementOfferTerms,
  now: PricingPaymentsNow & { card: PricingCardState },
): { reason: PricingRateNotSellingReason; fixes: PricingRateFix[] } | null {
  if (pricingRateSells(terms, now)) return null;
  const accepted = terms.payment.acceptedMethods ?? [];
  if (accepted.includes("card") && now.card !== "ready") {
    const [reason, fix] = CARD[now.card];
    // A flexible rate paid in full can let guests pay at the property instead, if the hotel takes that.
    const atProperty =
      terms.payment.kind === "full" &&
      terms.cancellation.kind !== "non_refundable" &&
      now.methods.includes("pay_at_property");
    return { reason, fixes: atProperty ? [fix, "allow_pay_at_property"] : [fix] };
  }
  if (terms.payment.kind === "deposit")
    return { reason: "deposits_off", fixes: ["change_rate_payment"] };
  if (accepted.includes("pay_at_property") && !now.methods.includes("pay_at_property"))
    return { reason: "pay_at_property_off", fixes: ["turn_pay_at_property_on"] };
  return { reason: "no_payment_method", fixes: ["change_rate_payment"] };
}
