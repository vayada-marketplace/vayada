import { freeCancellationUntil } from "@/lib/roomChoices";
import { resolveLocale } from "@/lib/utils";

type Tier = { minDaysBeforeCheckIn: number; refundPercent: number };
/** The stay the terms are worded for: its arrival and the hotel's date today (YYYY-MM-DD). The
 * server refunds by the hotel's calendar day, the deadline day included (VAY-2347). */
export type TermsStay = { checkIn: string; today: string };

const dayAfter = (value: string) => freeCancellationUntil(value, -1);

/** The hotel's country for the times line: an ISO code by its name in the page's language, a
 * name as it came, null without one (a hotel that hides its address sends none). */
export function hotelCountryName(country: string | null | undefined, locale?: string) {
  const value = country?.trim();
  if (!value) return null;
  if (!/^[A-Za-z]{2}$/.test(value)) return value;
  try {
    return (
      new Intl.DisplayNames([resolveLocale(locale)], { type: "region" }).of(value.toUpperCase()) ??
      value
    );
  } catch {
    return value;
  }
}

/** A partial refund's steps, most notice first, each with the days it covers: from the day after
 * the step before (none for the first) to its last day, as the server picks the step with the
 * most notice the guest still meets. */
export function refundSteps(tiers: readonly Tier[], stay: TermsStay) {
  let previous: string | null = null;
  return [...tiers]
    .sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn)
    .map((tier) => {
      const until = freeCancellationUntil(stay.checkIn, tier.minDaysBeforeCheckIn);
      const from = previous && dayAfter(previous);
      previous = until;
      return { ...tier, percent: tier.refundPercent, from, until, passed: stay.today > until };
    });
}
