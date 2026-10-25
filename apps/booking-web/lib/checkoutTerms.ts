import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { freeCancellationUntil } from "@/lib/roomChoices";
import { formatStayDate, resolveLocale } from "@/lib/utils";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];
type Tier = { minDaysBeforeCheckIn: number; refundPercent: number };
/** The stay the terms are worded for: its arrival and the hotel's date today (YYYY-MM-DD). The
 * server refunds by the hotel's calendar day, the deadline day included (VAY-2347). */
export type TermsStay = { checkIn: string; today: string };

const date = (value: string) => formatStayDate(value);
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);

/** The checkout's English words for its dates and times (VAY-2347). Steps 2 and 3 speak English;
 * the redesign moves these into next-intl, so they stay together here. */
export const checkoutCopy = {
  hotelTime: (country: string | null) =>
    country ? `local hotel time (${country})` : "local hotel time",
  allTimesLocal: (country: string | null) => `All times are ${checkoutCopy.hotelTime(country)}.`,
  nonRefundable:
    "Cancellation: non-refundable. If you cancel, change or don’t arrive, we charge the full amount.",
  freeUntil: (until: string) =>
    `Cancellation: free until the end of ${date(until)}, local hotel time. After that, or if you don’t arrive, we charge the full amount.`,
  freeEnded: (until: string) =>
    `Cancellation: free cancellation ended on ${date(until)}. If you cancel or don’t arrive, we charge the full amount.`,
  refundsUntil: (steps: readonly { percent: number; until: string }[]) =>
    `Cancellation: ${steps
      .map((s) => `${s.percent}% back if you cancel by the end of ${date(s.until)}`)
      .join("; ")}, local hotel time. After that, or if you don’t arrive, we keep the full amount.`,
  refundsEnded: (until: string) =>
    `Cancellation: refunds ended on ${date(until)}. If you cancel or don’t arrive, we keep the full amount.`,
  noRefund: "Cancellation: no refund. If you cancel or don’t arrive, we keep the full amount.",
  deadline: (until: string, count: number) =>
    `Free cancellation deadline: the end of ${date(until)}, local hotel time (${days(count)} before arrival).`,
  deadlinePassed: (until: string, count: number) =>
    `Free cancellation deadline: ${date(until)} (${days(count)} before arrival). It has passed, so free cancellation no longer applies to this stay.`,
  refundStep: (percent: number, until: string, count: number) =>
    `${percent}% refund if you cancel by the end of ${date(until)} (at least ${days(count)} before check-in).`,
  refundStepPassed: (percent: number, until: string, count: number) =>
    `${percent}% refund until the end of ${date(until)} (at least ${days(count)} before check-in): this date has passed.`,
  noRefundAfter: (until: string, count: number) =>
    `No refund after ${date(until)} (less than ${days(count)} before check-in).`,
};

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

/** A partial refund's steps, most notice first, each with the last day it still applies. */
export function refundSteps(tiers: readonly Tier[], stay: TermsStay) {
  return [...tiers]
    .sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn)
    .map((tier) => {
      const until = freeCancellationUntil(stay.checkIn, tier.minDaysBeforeCheckIn);
      return { ...tier, until, passed: stay.today > until };
    });
}

/** A room's cancellation in one sentence for this stay: a date, never a day count, and once the
 * deadline has passed it says so instead of promising a refund (VAY-2347). */
export function cancellationLine(cancellation: Cancellation, stay: TermsStay): string {
  if (cancellation.kind === "non_refundable") return checkoutCopy.nonRefundable;
  const terms = cancellation.terms;
  if (terms.flexibleCancellationType === "partial_refund") {
    // A 0% step refunds nothing, so it is no refund to promise.
    const steps = refundSteps(terms.partialRefundTiers ?? [], stay).filter(
      (step) => step.refundPercent > 0,
    );
    const open = steps.filter((step) => !step.passed);
    if (open.length)
      return checkoutCopy.refundsUntil(
        open.map((step) => ({ percent: step.refundPercent, until: step.until })),
      );
    const last = steps.at(-1);
    return last ? checkoutCopy.refundsEnded(last.until) : checkoutCopy.noRefund;
  }
  const until = freeCancellationUntil(stay.checkIn, terms.freeCancellationDeadlineDays);
  return stay.today > until ? checkoutCopy.freeEnded(until) : checkoutCopy.freeUntil(until);
}
