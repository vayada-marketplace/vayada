import { quoteTargetRoomSelection, type TargetQuotedRoomLine } from "./bookingWebMixedQuote.js";
import {
  createHttpError,
  objectValue,
  moneyToCents,
  moneyFromCents,
  type TargetCheckoutQuoteOfferRow,
} from "./bookingWebPublic.js";

type MixedQuote = Awaited<ReturnType<typeof quoteTargetRoomSelection>>;
export function mixedSelectionOffer(mixed: MixedQuote): TargetCheckoutQuoteOfferRow {
  return {
    ...mixed.lines[0]!.offer,
    paymentOptions: mixed.paymentOptions,
    roomSummary: {
      name: mixed.lines
        .map(
          (line) =>
            `${line.guests.length} × ${
              objectValue(line.offer.roomSummary)["name"] ?? line.roomTypeId
            }`,
        )
        .join(" + "),
    },
    roomTotal: mixed.totals["roomTotal"]!,
    taxesAndFees: mixed.totals["taxesAndFees"]!,
    discounts: mixed.totals["discounts"]!,
  };
}

export function mixedSelectionPromotion(mixed: MixedQuote) {
  const discountAmount = Number(mixed.totals["promotionDiscount"]);
  return discountAmount > 0
    ? {
        name: "Room promotions",
        type: "ROOM_COMBINATION",
        discountAmount,
        discountPercent:
          Number(mixed.totals["roomTotal"]) > 0
            ? (100 * discountAmount) / Number(mixed.totals["roomTotal"])
            : 0,
      }
    : null;
}

/** Allocate one booking discount without losing cents or discounting a zero-value line. */
export function allocateMixedQuoteDiscount(
  lines: TargetQuotedRoomLine[],
  discount: number,
  addonTotal: number,
) {
  const weights = [
    ...lines.map((line) => moneyToCents(line.totals.totalAmount)),
    moneyToCents(addonTotal),
  ];
  const total = weights.reduce((sum, amount) => sum + amount, 0n);
  const cents = moneyToCents(discount);
  if (cents > total) throw createHttpError(409, "Invalid booking discount.");
  const allocated = weights.map((amount) => (total ? (cents * amount) / total : 0n));
  let remainder = cents - allocated.reduce((sum, amount) => sum + amount, 0n);
  for (let index = 0; remainder && index < weights.length; index++) {
    if (allocated[index]! < weights[index]!) {
      allocated[index]! += 1n;
      remainder--;
    }
  }
  return {
    addonDiscount: moneyFromCents(allocated.at(-1)!),
    lines: lines.map((line, index) => ({
      ...line,
      totals: {
        ...line.totals,
        promoDiscount: moneyFromCents(allocated[index]!),
        totalAmount: moneyFromCents(weights[index]! - allocated[index]!),
      },
    })),
  };
}
