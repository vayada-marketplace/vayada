import {
  isMinorAmount,
  isPositiveMinor,
  pricingInteger,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms";
import type { ReplacementPromotionPolicy } from "@vayada/domain-booking";

type Discount = ReplacementPromotionPolicy["codes"][number]["discount"];
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200 && v === v.trim();
const validDiscount = (v: unknown): v is Discount | null =>
  v === null ||
  (pricingObject(v) &&
    ((v.kind === "percentage" &&
      pricingKeys(v, ["kind", "basisPoints"]) &&
      pricingInteger(v.basisPoints, 1) &&
      v.basisPoints <= 10000) ||
      (v.kind === "fixed" &&
        pricingKeys(v, ["kind", "amountMinor"]) &&
        isPositiveMinor(v.amountMinor))));
function reduction(base: bigint, discount: Discount | null): bigint {
  if (!discount) return 0n;
  if (discount.kind === "fixed")
    return BigInt(discount.amountMinor) < base ? BigInt(discount.amountMinor) : base;
  // Round the remaining price half-up, matching the agreed PMS/Booking price arithmetic.
  return base - (base * BigInt(10000 - discount.basisPoints) + 5000n) / 10000n;
}

/** Pure Booking arithmetic for already eligible, same-currency owner inputs.
 * Not an eligibility evaluator: dates, hotel/room switches, usage, targeting and
 * revision checks belong to current owner reads before constructing this input.
 * Room amounts include PMS child/linked adjustments; meals and other charges are excluded.
 * Null discounts and zero eligible extras must be explicit owner results, never fallbacks. */
export function composeReplacementDiscounts(input: unknown) {
  if (
    !pricingObject(input) ||
    !pricingKeys(input, ["rooms", "eligibleAddonMinor", "code", "stacking"]) ||
    !Array.isArray(input.rooms) ||
    !input.rooms.length ||
    input.rooms.length > 99 ||
    !isMinorAmount(input.eligibleAddonMinor) ||
    !validDiscount(input.code) ||
    typeof input.stacking !== "boolean"
  )
    return null;
  const rooms: Array<{
    selectionId: string;
    amount: bigint;
    lastMinute: bigint;
    codeEligible: boolean;
  }> = [];
  const ids = new Set<string>();
  for (const room of input.rooms) {
    if (
      !pricingObject(room) ||
      !pricingKeys(room, ["selectionId", "roomMinor", "lastMinute", "codeEligible"]) ||
      !text(room.selectionId) ||
      ids.has(room.selectionId) ||
      !isMinorAmount(room.roomMinor) ||
      !validDiscount(room.lastMinute) ||
      typeof room.codeEligible !== "boolean"
    )
      return null;
    ids.add(room.selectionId);
    const amount = BigInt(room.roomMinor);
    rooms.push({
      selectionId: room.selectionId,
      amount,
      lastMinute: reduction(amount, room.lastMinute),
      codeEligible: room.codeEligible,
    });
  }
  const addon = BigInt(input.eligibleAddonMinor);
  const roomAndEligibleAddon = rooms.reduce((sum, r) => sum + r.amount, addon);
  if (roomAndEligibleAddon > 999999999999999999n) return null;
  const lastMinute = rooms.reduce((sum, r) => sum + r.lastMinute, 0n);
  const codeBase = rooms
    .filter((r) => r.codeEligible)
    .reduce((sum, r) => sum + r.amount - (input.stacking ? r.lastMinute : 0n), addon);
  const code = reduction(codeBase, input.code);
  const useLastMinute = input.stacking || lastMinute >= code;
  const useCode = input.stacking || code > lastMinute;
  const lastMinuteLines = rooms
    .filter((r) => useLastMinute && r.lastMinute > 0n)
    .map((r) => ({ selectionId: r.selectionId, amountMinor: r.lastMinute.toString() }));
  const appliedLastMinute = useLastMinute ? lastMinute : 0n,
    appliedCode = useCode ? code : 0n;
  const total = appliedLastMinute + appliedCode;
  return {
    version: "booking.discount-components.v1" as const,
    lastMinuteLines,
    codeMinor: appliedCode.toString(),
    totalDiscountMinor: total.toString(),
    remainingRoomAndEligibleAddonMinor: (roomAndEligibleAddon - total).toString(),
  };
}
