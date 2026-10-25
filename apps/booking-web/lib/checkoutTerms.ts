import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { freeCancellationUntil } from "@/lib/roomChoices";
import { formatStayDate, resolveLocale } from "@/lib/utils";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];
type Tier = { minDaysBeforeCheckIn: number; refundPercent: number };
/** One refund step for the guest: its share and the days it covers (`from` is null for the first). */
type Window = { percent: number; from: string | null; until: string };
/** The stay the terms are worded for: its arrival and the hotel's date today (YYYY-MM-DD). The
 * server refunds by the hotel's calendar day, the deadline day included (VAY-2347). */
export type TermsStay = { checkIn: string; today: string };

const date = (value: string) => formatStayDate(value);
const dayAfter = (value: string) => freeCancellationUntil(value, -1);
const days = (count: number) => (count === 1 ? "1 day" : `${count} days`);
const notice = (count: number) =>
  count === 0 ? "up to the arrival day" : `at least ${days(count)} before check-in`;
// Each step names both its days: refunds can rise again with less notice (100%, then 0%, then 50%).
const window = (w: Window) => (w.from ? `from ${date(w.from)} to` : "by");

/** The checkout's English words for its dates and times (VAY-2347). Steps 2 and 3 speak English;
 * the redesign moves these into next-intl, so they stay together here. */
export const checkoutCopy = {
  allTimesLocal: (country: string | null) =>
    `All times are local hotel time${country ? ` (${country})` : ""}.`,
  nonRefundable:
    "Cancellation: non-refundable. If you cancel, change or don’t arrive, we charge the full amount.",
  freeUntil: (until: string) =>
    `Cancellation: free until the end of ${date(until)}, local hotel time. After that, or if you don’t arrive, we charge the full amount.`,
  freeEnded: (until: string) =>
    `Cancellation: free cancellation ended on ${date(until)}. If you cancel or don’t arrive, we charge the full amount.`,
  refundsUntil: (steps: readonly Window[]) =>
    `Cancellation: ${steps
      .map(
        (s) =>
          `${s.percent ? `${s.percent}% back` : "no refund"} if you cancel ${window(s)} the end of ${date(s.until)}`,
      )
      .join("; ")}, local hotel time. After that, or if you don’t arrive, we keep the full amount.`,
  refundsEnded: (until: string) =>
    `Cancellation: refunds ended on ${date(until)}. If you cancel or don’t arrive, we keep the full amount.`,
  noRefund: "Cancellation: no refund. If you cancel or don’t arrive, we keep the full amount.",
  deadline: (until: string, count: number) =>
    `Free cancellation deadline: the end of ${date(until)}, local hotel time (${count ? `${days(count)} before arrival` : "the arrival day"}).`,
  deadlinePassed: (until: string, count: number) =>
    `Free cancellation deadline: ${date(until)} (${count ? `${days(count)} before arrival` : "the arrival day"}). It has passed, so free cancellation no longer applies to this stay.`,
  refundStep: (w: Window, count: number) =>
    `${w.percent ? `${w.percent}% refund` : "No refund"} if you cancel ${window(w)} the end of ${date(w.until)} (${notice(count)}).`,
  refundStepPassed: (w: Window, count: number) =>
    `${w.percent ? `${w.percent}% refund` : "No refund"} until the end of ${date(w.until)} (${notice(count)}): this date has passed.`,
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

/** A room's cancellation in one sentence for this stay: a date, never a day count, and once the
 * deadline has passed it says so instead of promising a refund (VAY-2347). */
export function cancellationLine(cancellation: Cancellation, stay: TermsStay): string {
  if (cancellation.kind === "non_refundable") return checkoutCopy.nonRefundable;
  const terms = cancellation.terms;
  if (terms.flexibleCancellationType === "partial_refund") {
    const all = refundSteps(terms.partialRefundTiers ?? [], stay);
    // 0% steps after the last refund are what "after that" says; one between refunds stays.
    const steps = all.slice(0, all.map((step) => step.percent > 0).lastIndexOf(true) + 1);
    const open = steps.filter((step) => !step.passed);
    // The step that applies today reads "by": its first day is already behind the guest.
    if (open[0]?.from && open[0].from <= stay.today) open[0] = { ...open[0], from: null };
    if (open.length) return checkoutCopy.refundsUntil(open);
    const last = steps.at(-1);
    return last ? checkoutCopy.refundsEnded(last.until) : checkoutCopy.noRefund;
  }
  const until = freeCancellationUntil(stay.checkIn, terms.freeCancellationDeadlineDays);
  return stay.today > until ? checkoutCopy.freeEnded(until) : checkoutCopy.freeUntil(until);
}

/** The payment step's Cancellation box: one line per policy, named by its rooms when rooms differ. */
export function cancellationSummary(
  rooms: readonly { name: string; cancellation: Cancellation }[],
  stay: TermsStay,
): string[] {
  const lines = rooms.map((room) => {
    const line = cancellationLine(room.cancellation, stay).replace(/^Cancellation: /, "");
    return line.charAt(0).toUpperCase() + line.slice(1);
  });
  const distinct = Array.from(new Set(lines));
  if (distinct.length < 2) return distinct;
  return distinct.map((line) => {
    const names = new Set(
      rooms.filter((_, index) => lines[index] === line).map((room) => room.name),
    );
    return `${Array.from(names).join(", ")}: ${line}`;
  });
}
