import { isPositiveMinor, parseFlexibleCancellationTerms, pricingDate } from "@vayada/domain-pms";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";

export type BookedCancellation = ReplacementOfferTerms["cancellation"];
/** One booked room: the terms frozen at acceptance and its own lines (room, meal, room-scoped extras). */
export type BookedCancellationRoom = Readonly<{
  selectionId: string;
  cancellation: BookedCancellation;
  subtotalMinor: string;
}>;
export type BookedCancellationRoomOutcome = Readonly<{
  selectionId: string;
  rule: "non_refundable" | "free_until_deadline" | "partial_refund";
  refundPercent: number;
  matchedTierMinDays: number | null;
  baseMinor: string;
  refundMinor: string;
  retainedMinor: string;
}>;
export type BookedCancellationOutcome = Readonly<{
  daysBeforeCheckIn: number;
  totalMinor: string;
  refundMinor: string;
  retainedMinor: string;
  rooms: readonly BookedCancellationRoomOutcome[];
}>;

/**
 * What the booked terms refund if the stay is cancelled on `cancelledOn` (property-local date).
 * Partial refund: the tier with the largest notice the guest still meets (inclusive) decides;
 * no tier met refunds nothing, and `freeCancellationDeadlineDays` plays no part. Free cancellation:
 * everything until the deadline, then nothing. Non-refundable: nothing. The accepted total is
 * shared across rooms in proportion to their own lines, so booking-level add-ons, charges and
 * discounts follow each room's terms. Integer minor units, half-up rounding per room.
 * Returns null when the input cannot be trusted; callers must then refuse, never guess.
 */
export function resolveBookedCancellationOutcome(input: {
  checkIn: string;
  cancelledOn: string;
  totalMinor: string;
  rooms: readonly BookedCancellationRoom[];
}): BookedCancellationOutcome | null {
  const { checkIn, cancelledOn, totalMinor, rooms } = input;
  if (
    !pricingDate(checkIn) ||
    !pricingDate(cancelledOn) ||
    !isPositiveMinor(totalMinor) ||
    !rooms.length ||
    new Set(rooms.map((room) => room.selectionId)).size !== rooms.length ||
    rooms.some((room) => !room.selectionId || !isPositiveMinor(room.subtotalMinor))
  )
    return null;
  const days = Math.round(
    (Date.parse(`${checkIn}T00:00:00Z`) - Date.parse(`${cancelledOn}T00:00:00Z`)) / 86_400_000,
  );
  const rules = rooms.map((room) => roomRule(room.cancellation, days));
  if (rules.some((rule) => rule === null)) return null;

  const total = BigInt(totalMinor),
    subtotals = rooms.map((room) => BigInt(room.subtotalMinor));
  const sum = subtotals.reduce((a, b) => a + b, 0n);
  const bases = subtotals.map((subtotal) => (total * subtotal) / sum);
  // Largest remainder: the room bases add up to the accepted total exactly.
  let left = total - bases.reduce((a, b) => a + b, 0n);
  const order = subtotals
    .map((subtotal, index) => ({ index, remainder: (total * subtotal) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (left === 0n) break;
    bases[index]! += 1n;
    left -= 1n;
  }

  const outcomes = rooms.map((room, index): BookedCancellationRoomOutcome => {
    const rule = rules[index]!,
      base = bases[index]!;
    const refund = (base * BigInt(rule.refundPercent) + 50n) / 100n;
    return {
      selectionId: room.selectionId,
      ...rule,
      baseMinor: base.toString(),
      refundMinor: refund.toString(),
      retainedMinor: (base - refund).toString(),
    };
  });
  const refund = outcomes.reduce((a, room) => a + BigInt(room.refundMinor), 0n);
  return {
    daysBeforeCheckIn: days,
    totalMinor: total.toString(),
    refundMinor: refund.toString(),
    retainedMinor: (total - refund).toString(),
    rooms: outcomes,
  };
}

function roomRule(cancellation: BookedCancellation, days: number) {
  if (cancellation?.kind === "non_refundable")
    return { rule: "non_refundable" as const, refundPercent: 0, matchedTierMinDays: null };
  const terms =
    cancellation?.kind === "flexible" ? parseFlexibleCancellationTerms(cancellation.terms) : null;
  if (!terms) return null;
  if (terms.flexibleCancellationType !== "partial_refund")
    return {
      rule: "free_until_deadline" as const,
      refundPercent: days >= terms.freeCancellationDeadlineDays ? 100 : 0,
      matchedTierMinDays: null,
    };
  const tier = (terms.partialRefundTiers ?? [])
    .filter((t) => days >= t.minDaysBeforeCheckIn)
    .sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn)[0];
  return {
    rule: "partial_refund" as const,
    refundPercent: tier?.refundPercent ?? 0,
    matchedTierMinDays: tier?.minDaysBeforeCheckIn ?? null,
  };
}
