import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";

type MealPlan = PricingConfiguration["offers"][number]["meal"]["kind"];

/** What a guest may learn about an option's cancellation before asking for a price: no refund, free until a number
 * of days before arrival, or a partial refund. Penalties and refund tiers stay with the quote. */
export type PublicOfferCancellation =
  | Readonly<{ kind: "non_refundable" }>
  | Readonly<{ kind: "free_until_days_before_arrival"; days: number }>
  | Readonly<{ kind: "partial_refund" }>;

export function publicOfferCancellation(
  cancellation: ReplacementOfferTerms["cancellation"],
): PublicOfferCancellation {
  if (cancellation.kind === "non_refundable") return { kind: "non_refundable" };
  const terms = cancellation.terms;
  if (terms.flexibleCancellationType !== "partial_refund")
    return { kind: "free_until_days_before_arrival", days: terms.freeCancellationDeadlineDays };
  // A "partial" refund that refunds nothing at any point is no refund.
  const percents = terms.partialRefundTiers?.map((tier) => tier.refundPercent) ?? [
    terms.partialRefundAmountPercent ?? 0,
  ];
  return percents.every((percent) => percent === 0)
    ? { kind: "non_refundable" }
    : { kind: "partial_refund" };
}

/** An option's plain name as a meal and a cancellation, for an app to word: "room_only" + "free" is "Free
 * cancellation", "breakfast" + "non_refundable" is "Breakfast included, non-refundable", and so on. A null
 * cancellation (unknown) names the meal alone. `days` is a free cancellation's deadline: a page that knows the stay
 * says "until <date>" with it, and a stay that starts inside the deadline has no free cancellation. */
export type PricingOfferNameKey = Readonly<{
  meal: MealPlan;
  cancellation: "free" | "non_refundable" | "partial_refund" | null;
  days: number | null;
  /** 2, 3, … for a later option of the same room with the same name; null for the first. */
  number: number | null;
}>;

/** One room's options, in order, as name keys: the same words in the PMS and on the booking page. */
export function pricingOfferNameKeys(
  offers: readonly Readonly<{
    mealPlan: MealPlan;
    cancellation: PublicOfferCancellation | null | undefined;
  }>[],
): PricingOfferNameKey[] {
  const used = new Map<string, number>();
  return offers.map((offer) => {
    const cancellation =
      offer.cancellation?.kind === "free_until_days_before_arrival"
        ? "free"
        : (offer.cancellation?.kind ?? null);
    const name = `${offer.mealPlan}:${cancellation}`;
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    return {
      meal: offer.mealPlan,
      cancellation,
      days:
        offer.cancellation?.kind === "free_until_days_before_arrival"
          ? offer.cancellation.days
          : null,
      number: count === 1 ? null : count,
    };
  });
}
