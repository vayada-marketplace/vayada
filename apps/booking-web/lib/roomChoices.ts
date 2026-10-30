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

/** One room's choices, in order. With the stay, a free cancellation already over for it (or a
 * partial refund past its last refund day, VAY-2406) is numbered as the no-refund choice it now
 * reads as (VAY-2392), after the room's own no-refund choices, so two choices never read
 * "Non-refundable" alike. */
export function choiceKeys(
  offers: readonly PricingOffer[],
  stay?: { checkIn: string; timezone?: string },
  now = new Date(),
): ChoiceKeys[] {
  const keys = pricingOfferNameKeys(
    offers.map(({ mealPlan, cancellation }) => ({ mealPlan, cancellation })),
  );
  const passed = keys.map(({ days }) => !!stay && days !== null && refundsEnded(stay, days, now));
  // The passed ones are numbered last, so the room's own no-refund choice keeps the plain name.
  const order = offers.map((_, index) => index).sort((a, b) => +passed[a]! - +passed[b]!);
  const numbers = pricingOfferNameKeys(
    order.map((index) => ({
      mealPlan: offers[index]!.mealPlan,
      cancellation: passed[index]
        ? { kind: "non_refundable" as const }
        : offers[index]!.cancellation,
    })),
  );
  return keys.map((own, index) => {
    const mealDescription = offers[index]!.mealDescription;
    return {
      ...own,
      number: numbers[order.indexOf(index)]!.number,
      ...(mealDescription && { mealDescription }),
    };
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

/** The stay's last free-cancellation day, null without a valid arrival date. */
function freeUntil(checkIn: string, days: number): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(checkIn) && !Number.isNaN(Date.parse(checkIn))
    ? freeCancellationUntil(checkIn, days)
    : null;
}

/** Free cancellation, or a partial refund's last step, `days` before arrival is over on the
 * hotel's calendar today. */
function refundsEnded(
  stay: { checkIn: string; timezone?: string },
  days: number,
  now: Date,
): boolean {
  const until = freeUntil(stay.checkIn, days);
  return until !== null && hotelToday(stay.timezone, now) > until;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

export type ChoiceText = {
  name: string;
  terms: string;
  /** The meal's name, null for room only, and the cancellation's words, null when unknown: a
   * booked room's line (VAY-2320). */
  meal: string | null;
  cancellationTerms: string | null;
  /** The rate icon: the arrows for free or partial cancellation, a cross for no refund (also
   * once free cancellation or the last refund step has passed), none when the cancellation isn't
   * known. */
  refundable: boolean | null;
  /** Free cancellation whose deadline has passed for this stay, or a partial refund past its last
   * refund day (VAY-2406). */
  cancellationPassed: boolean;
};

/** A choice's guest-facing name and one line of terms (home.choice messages). Free
 * cancellation reads as a date for the stay; once that date has passed the choice is named
 * non-refundable, as the server refunds it, and says why (VAY-2392). So is a partial refund past
 * its last refund day, as Review & pay says "No refund any more" (VAY-2406). */
export function choiceText(
  keys: ChoiceKeys,
  stay: { checkIn: string; timezone?: string; formatDate: (date: string) => string },
  t: Translate,
  now = new Date(),
): ChoiceText {
  // Without a stay (/book before dates are chosen) there is no deadline to word yet.
  const until = keys.days === null ? null : freeUntil(stay.checkIn, keys.days);
  const cancellationPassed = until !== null && hotelToday(stay.timezone, now) > until;
  const cancellation = cancellationPassed ? "non_refundable" : keys.cancellation;
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
    ? t(keys.cancellation === "partial_refund" ? "choice.refundsPassed" : "choice.windowPassed", {
        days: keys.days!,
      })
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
