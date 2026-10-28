import {
  freeCancellationUntil,
  pricingOfferNameKeys,
  type PricingOfferNameKey,
} from "@vayada/domain-booking/replacement-pricing";
import type { PricingOffer } from "@/services/api/replacementOffers";

/** The parts of a choice's plain name, shared with the PMS (VAY-2188): its meal, how it cancels,
 * free cancellation's deadline in days and, for two choices that would read the same in one
 * room, a number ("Free cancellation 2"). Plus the hotel's own meal text, if any (VAY-2281). */
export type ChoiceKeys = PricingOfferNameKey & { mealDescription?: string };

export function choiceKeys(offers: readonly PricingOffer[]): ChoiceKeys[] {
  return pricingOfferNameKeys(
    offers.map(({ mealPlan, cancellation }) => ({ mealPlan, cancellation })),
  ).map((keys, index) => {
    const mealDescription = offers[index]!.mealDescription;
    return mealDescription ? { ...keys, mealDescription } : keys;
  });
}

/** Today in the hotel's time zone (YYYY-MM-DD), so every guest sees the hotel's deadline. Without
 * a zone it is UTC, as on the server, never the guest's device's. */
export function hotelToday(timezone?: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Etc/UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

export type ChoiceText = {
  name: string;
  terms: string;
  /** The meal's name, null for room only, and the cancellation's words, null when unknown: a
   * booked room's line (VAY-2320). */
  meal: string | null;
  cancellationTerms: string | null;
  /** The rate icon: the arrows for free or partial cancellation, a cross for no refund, none
   * when the cancellation isn't known or free cancellation has passed. */
  refundable: boolean | null;
  /** Free cancellation whose deadline has passed for this stay. */
  cancellationPassed: boolean;
};

/** A choice's guest-facing name and one line of terms (home.choice messages). Free
 * cancellation reads as a date for the stay; once that date has passed the choice is named by
 * its meal and says cancellation is no longer available. */
export function choiceText(
  keys: ChoiceKeys,
  stay: { checkIn: string; timezone?: string; formatDate: (date: string) => string },
  t: Translate,
  now = new Date(),
): ChoiceText {
  // Without a stay (/book before dates are chosen) there is no deadline to word yet.
  const until =
    keys.days === null ||
    !/^\d{4}-\d{2}-\d{2}$/.test(stay.checkIn) ||
    Number.isNaN(Date.parse(stay.checkIn))
      ? null
      : freeCancellationUntil(stay.checkIn, keys.days);
  const cancellationPassed = until !== null && hotelToday(stay.timezone, now) > until;
  const cancellation = cancellationPassed ? null : keys.cancellation;
  const meal = t(`choice.meal.${keys.meal}`);
  const base =
    keys.meal === "room_only"
      ? cancellation === "free"
        ? t("choice.freeCancellation")
        : cancellation === "non_refundable"
          ? t("choice.nonRefundable")
          : cancellation === "partial_refund"
            ? t("choice.partialRefund")
            : meal
      : cancellation === "non_refundable"
        ? t("choice.mealNonRefundable", { meal })
        : cancellation === "partial_refund"
          ? t("choice.mealPartialRefund", { meal })
          : meal;
  const cancellationTerms = cancellationPassed
    ? t("choice.noLongerFree")
    : cancellation === "free" && until
      ? t("choice.freeUntil", { date: stay.formatDate(until) })
      : cancellation === "non_refundable"
        ? t("choice.noRefund")
        : cancellation === "partial_refund"
          ? t("choice.partialRefundTerms")
          : null;
  const terms = [
    // The hotel's own meal text when it wrote one, shown as written (not translated).
    keys.mealDescription ?? (keys.meal === "room_only" ? null : t(`choice.mealTerms.${keys.meal}`)),
    cancellationTerms,
  ].filter(Boolean);
  return {
    name: keys.number ? `${base} ${keys.number}` : base,
    terms: terms.join(" · "),
    meal: keys.meal === "room_only" ? null : meal,
    cancellationTerms,
    refundable:
      cancellation === "free" || cancellation === "partial_refund"
        ? true
        : cancellation === "non_refundable"
          ? false
          : null,
    cancellationPassed,
  };
}
