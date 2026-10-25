import {
  isManualPricingPaymentMethod,
  type PublicBookingQuote,
} from "@vayada/domain-booking/replacement-pricing";
import { refundSteps, type TermsStay } from "@/lib/checkoutTerms";
import { freeCancellationUntil } from "@/lib/roomChoices";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];

/** When a row applies: dates are the hotel's calendar days (YYYY-MM-DD). */
export type PolicyWhen =
  | { kind: "untilEnd"; date: string }
  | { kind: "until"; date: string }
  | { kind: "between"; from: string; until: string }
  | { kind: "from"; date: string }
  | { kind: "fromNow" }
  | { kind: "fromBooking" }
  | { kind: "beforeAccept" }
  | { kind: "afterAccept" }
  /** VAY-2348: a bank transfer booking, before its money arrives, without it, and once paid. */
  | { kind: "beforeTransfer" }
  | { kind: "noTransfer" }
  | { kind: "paidUntilEnd"; date: string }
  | { kind: "afterTransfer" }
  | { kind: "noShow" };
/** What the guest pays if they cancel then: amounts in the price's minor units. */
export type PolicyPay =
  | { kind: "free" }
  | { kind: "freeNothingCharged" }
  | { kind: "freeHoldReleased" }
  | { kind: "freeNothingPaid" }
  | { kind: "releasedNothingCharged" }
  | { kind: "fullRefund" }
  | { kind: "part"; percent: number; amountMinor: string }
  | { kind: "full"; amountMinor: string };
export type PolicyRow = { when: PolicyWhen; pay: PolicyPay; now: boolean; ended: boolean };
export type PolicyBadge =
  | { kind: "freeUntil" | "refundsUntil"; date: string }
  | {
      kind:
        | "freeEnded"
        | "nonRefundable"
        | "noRefund"
        | "notRefundableOnceAccepted"
        | "notRefundableOncePaid";
    };
export type PolicyNote =
  | {
      kind:
        | "freeUntil"
        | "freeEnded"
        | "partial"
        | "partialEnded"
        // VAY-2348: a bank transfer's terms start once its money has arrived.
        | "paidFreeUntil"
        | "paidFreeEnded"
        | "paidPartialEnded";
      date: string;
    }
  | { kind: "nonRefundable" };
export type Policy = {
  badge: PolicyBadge;
  tone: "ok" | "amber";
  rows: PolicyRow[];
  note: PolicyNote;
  /** The hotel accepts each booking: withdrawing before it answers is free. */
  request: boolean;
  /** VAY-2348: a bank transfer booking is released, nothing charged, without its money in 48 h. */
  bankTransfer: boolean;
};
/** One policy and the rooms it covers (VAY-2347, D7: one block per policy). `key` tells blocks
 * apart; `today` is the hotel's date, so dates in another year can say theirs. */
export type PolicyBlock = { key: string; rooms: string[]; policy: Policy; today: string };

const dayAfter = (date: string) => freeCancellationUntil(date, -1);

/** One rate's cancellation for this stay as step 3 shows it (VAY-2347): the rate's real terms
 * (D2), dated on the hotel's calendar and judged against the hotel's date today, as the server
 * refunds (`bookedCancellationOutcome`): a free window or a refund step includes its last day, and
 * after the last one, or for a no-show, the guest pays the full amount. `amount` is the price, or
 * each room's share of it: a part refund is then rounded per room, as the server refunds. */
export function cancellationPolicy(
  cancellation: Cancellation,
  stay: TermsStay,
  amount: string | readonly bigint[],
  mode: { request: boolean; card: boolean; bankTransfer?: boolean },
): Policy {
  const bases = typeof amount === "string" ? [BigInt(amount)] : amount;
  const amountMinor = String(bases.reduce((a, b) => a + b, BigInt(0)));
  // What the guest pays when the hotel refunds `percent`: half-up per room.
  const kept = (percent: number) =>
    String(
      bases.reduce(
        (sum, base) => sum + base - (base * BigInt(percent) + BigInt(50)) / BigInt(100),
        BigInt(0),
      ),
    );
  const full: PolicyPay = { kind: "full", amountMinor };
  const noShow: PolicyRow = { when: { kind: "noShow" }, pay: full, now: false, ended: false };
  let rows: PolicyRow[];
  let badge: PolicyBadge;
  let note: PolicyNote;
  // Whether a refund is still open today: a request then keeps the rate's own badge.
  let refundable: boolean;
  const terms = cancellation.kind === "flexible" ? cancellation.terms : null;
  const steps =
    terms?.flexibleCancellationType === "partial_refund"
      ? refundSteps(terms.partialRefundTiers ?? [], stay)
      : [];
  // 0% steps after the last refund are the "from" row; one between refunds stays.
  const relevant = steps.slice(0, steps.map((s) => s.percent > 0).lastIndexOf(true) + 1);
  if (!terms || (terms.flexibleCancellationType === "partial_refund" && !relevant.length)) {
    // A partial-refund rate without a refund step never refunded: it reads as non-refundable.
    rows = [{ when: { kind: "fromBooking" }, pay: full, now: true, ended: false }];
    badge = { kind: "nonRefundable" };
    note = { kind: "nonRefundable" };
    refundable = false;
  } else if (relevant.length) {
    const last = relevant.at(-1)!.until;
    const over = stay.today > last;
    rows = relevant.map((step) => ({
      when: step.from
        ? { kind: "between", from: step.from, until: step.until }
        : { kind: "untilEnd", date: step.until },
      pay:
        step.percent === 100
          ? { kind: "free" }
          : step.percent === 0
            ? full
            : { kind: "part", percent: 100 - step.percent, amountMinor: kept(step.percent) },
      now: !step.passed && (!step.from || step.from <= stay.today),
      ended: step.passed,
    }));
    rows.push({ when: { kind: "from", date: dayAfter(last) }, pay: full, now: over, ended: false });
    const open = relevant.filter((step) => !step.passed && step.percent > 0);
    refundable = open.length > 0;
    badge = !open.length
      ? { kind: "noRefund" }
      : open[0]!.percent === 100 && open.length === 1
        ? { kind: "freeUntil", date: open[0]!.until }
        : { kind: "refundsUntil", date: open.at(-1)!.until };
    note = { kind: over ? "partialEnded" : "partial", date: last };
  } else {
    const until = freeCancellationUntil(stay.checkIn, terms.freeCancellationDeadlineDays);
    refundable = stay.today <= until;
    rows = refundable
      ? [
          {
            when: { kind: "untilEnd", date: until },
            pay: { kind: "free" },
            now: true,
            ended: false,
          },
          { when: { kind: "from", date: dayAfter(until) }, pay: full, now: false, ended: false },
        ]
      : [
          { when: { kind: "until", date: until }, pay: { kind: "free" }, now: false, ended: true },
          { when: { kind: "fromNow" }, pay: full, now: true, ended: false },
        ];
    badge = refundable ? { kind: "freeUntil", date: until } : { kind: "freeEnded" };
    note = { kind: refundable ? "freeUntil" : "freeEnded", date: until };
  }
  if (mode.request) {
    // Before the hotel answers the guest can withdraw for free; the rate's terms apply once it
    // accepts, so "now" and "from booking" become "after the hotel accepts".
    rows = [
      {
        when: { kind: "beforeAccept" },
        pay: { kind: mode.card ? "freeHoldReleased" : "freeNothingCharged" },
        now: true,
        ended: false,
      },
      ...rows.map((row) => ({
        ...row,
        now: false,
        when:
          row.when.kind === "fromNow" || row.when.kind === "fromBooking"
            ? ({ kind: "afterAccept" } as const)
            : row.when,
      })),
    ];
    if (!refundable) badge = { kind: "notRefundableOnceAccepted" };
  }
  const bankTransfer = !mode.request && !!mode.bankTransfer;
  if (bankTransfer) {
    // VAY-2348: until the transfer arrives nothing is paid, and without it the booking is released;
    // the rate's terms apply once it is paid, so "free" is a full refund then.
    rows = [
      {
        when: { kind: "beforeTransfer" },
        pay: { kind: "freeNothingPaid" },
        now: true,
        ended: false,
      },
      {
        when: { kind: "noTransfer" },
        pay: { kind: "releasedNothingCharged" },
        now: false,
        ended: false,
      },
      ...rows.map((row) => ({
        ...row,
        now: false,
        when:
          row.when.kind === "untilEnd"
            ? ({ kind: "paidUntilEnd", date: row.when.date } as const)
            : row.when.kind === "fromNow" || row.when.kind === "fromBooking"
              ? ({ kind: "afterTransfer" } as const)
              : row.when,
        pay: row.pay.kind === "free" ? ({ kind: "fullRefund" } as const) : row.pay,
      })),
    ];
    if (!refundable) badge = { kind: "notRefundableOncePaid" };
    // Cancelling before the transfer arrives is free, so the notes say "once it has arrived".
    if (note.kind === "freeUntil") note = { kind: "paidFreeUntil", date: note.date };
    if (note.kind === "freeEnded") note = { kind: "paidFreeEnded", date: note.date };
    if (note.kind === "partialEnded") note = { kind: "paidPartialEnded", date: note.date };
  }
  const tone = badge.kind === "freeUntil" || badge.kind === "refundsUntil" ? "ok" : "amber";
  return { badge, tone, rows: [...rows, noShow], note, request: mode.request, bankTransfer };
}

/** Each room's share of the price's total, in proportion to its own lines (room, meal, its
 * extras, less its discounts), as the server shares booking-level lines out (largest
 * remainder). */
export function roomShares(quote: PublicBookingQuote): bigint[] {
  const total = BigInt(quote.totalMinor);
  const subtotals = quote.rooms.map((room) =>
    quote.lines
      .filter((line) => line.selectionId === room.selectionId)
      .reduce(
        (sum, line) =>
          line.kind === "discount"
            ? sum - BigInt(line.amountMinor)
            : sum + BigInt(line.amountMinor),
        BigInt(0),
      ),
  );
  const sum = subtotals.reduce((a, b) => a + b, BigInt(0));
  if (sum <= BigInt(0)) return quote.rooms.map((_, index) => (index === 0 ? total : BigInt(0)));
  const shares = subtotals.map((subtotal) => (total * subtotal) / sum);
  let left = total - shares.reduce((a, b) => a + b, BigInt(0));
  const order = subtotals
    .map((subtotal, index) => ({ index, remainder: (total * subtotal) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (left === BigInt(0)) break;
    shares[index]! += BigInt(1);
    left -= BigInt(1);
  }
  return shares;
}

/** What decides a rate's policy, so rates with the same terms share a block: its text and
 * fields the policy doesn't use are left out. */
function policyKey(cancellation: Cancellation) {
  const terms = cancellation.kind === "flexible" ? cancellation.terms : null;
  if (!terms) return "non_refundable";
  if (terms.flexibleCancellationType !== "partial_refund")
    return `free:${terms.freeCancellationDeadlineDays}`;
  const tiers = (terms.partialRefundTiers ?? [])
    .map((tier) => [tier.minDaysBeforeCheckIn, tier.refundPercent])
    .sort((a, b) => b[0]! - a[0]!);
  return `partial:${JSON.stringify(tiers)}`;
}

/** The stay's policies, one block per distinct rate policy with the rooms it covers (D7). */
export function policyBlocks(
  quote: PublicBookingQuote,
  { today, roomNames }: { today: string; roomNames: Readonly<Record<string, string>> },
): PolicyBlock[] {
  const shares = roomShares(quote);
  const request =
    quote.acceptanceMode === "request" && !isManualPricingPaymentMethod(quote.paymentMethod);
  const groups = new Map<
    string,
    { rooms: string[]; shares: bigint[]; cancellation: Cancellation }
  >();
  quote.rooms.forEach((room, index) => {
    const key = policyKey(room.cancellation);
    const group = groups.get(key) ?? { rooms: [], shares: [], cancellation: room.cancellation };
    const name = roomNames[room.selectionId] ?? "";
    // Two rooms of one kind on one rate read once.
    if (!group.rooms.includes(name)) group.rooms.push(name);
    group.shares.push(shares[index]!);
    groups.set(key, group);
  });
  return Array.from(groups, ([key, group]) => ({
    key,
    rooms: group.rooms,
    today,
    policy: cancellationPolicy(
      group.cancellation,
      { checkIn: quote.checkIn, today },
      group.shares,
      {
        request,
        card: quote.paymentMethod === "card",
        bankTransfer: quote.paymentMethod === "bank_transfer",
      },
    ),
  }));
}
