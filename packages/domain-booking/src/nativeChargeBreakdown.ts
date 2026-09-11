/** Arithmetic interpretation of native-checkout-charge.v1, not tax classification,
 * booking acceptance, canonical item allocation or proof of payment. Only trusted
 * Booking-owned snapshots belong here; no browser/provider inputs are authenticated.
 */
export function decomposeNativeCheckoutCharge(input: {
  contractVersion: string;
  totals: unknown;
  selectedOffer: unknown;
}):
  | {
      status: "pending";
      reason: "unsupported_source" | "mixed_allocation_required" | "promo_allocation_required";
    }
  | { status: "needs_review"; reason: "invalid_charge_breakdown" }
  | {
      status: "reported_components";
      currency: string;
      scale: 2;
      reportedRoomMinor: string;
      reportedTaxesAndFeesMinor: string;
      reportedExtrasMinor: string;
      totalMinor: string;
      taxClassification: "unverified";
    } {
  if (input?.contractVersion !== "native-checkout-charge.v1")
    return { status: "pending", reason: "unsupported_source" };
  const totals = object(input.totals),
    offer = object(input.selectedOffer);
  const invalid = { status: "needs_review", reason: "invalid_charge_breakdown" } as const;
  if (
    !totals ||
    !offer ||
    typeof totals.currency !== "string" ||
    !/^[A-Z]{3}$/.test(totals.currency)
  )
    return invalid;
  if (offer.roomSelection !== undefined || offer.roomLines !== undefined)
    return { status: "pending", reason: "mixed_allocation_required" };
  const room = minor(totals.roomTotal),
    tax = minor(totals.taxesAndFees),
    extras = minor(totals.addonTotal),
    discount = minor(totals.discounts),
    promo = minor(totals.promoDiscount),
    total = minor(totals.totalAmount),
    promotion = minor(totals.promotionDiscount === undefined ? 0 : totals.promotionDiscount);
  if (
    room === null ||
    tax === null ||
    extras === null ||
    discount === null ||
    promo === null ||
    total === null ||
    promotion === null
  )
    return invalid;
  if (
    discount + promotion > room ||
    (promo > 0n && promotion > 0n) ||
    room + tax + extras - discount - promo - promotion !== total
  )
    return invalid;
  // Native single-type promo is booking-wide: do not invent allocation to rooms.
  if (promo > 0n && (tax > 0n || extras > 0n))
    return { status: "pending", reason: "promo_allocation_required" };
  const roomNet = room - discount - promotion - promo;
  if (roomNet < 0n) return invalid;
  return Object.freeze({
    status: "reported_components",
    currency: totals.currency,
    scale: 2,
    reportedRoomMinor: roomNet.toString(),
    reportedTaxesAndFeesMinor: tax.toString(),
    reportedExtrasMinor: extras.toString(),
    totalMinor: total.toString(),
    taxClassification: "unverified",
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function minor(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^(0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
