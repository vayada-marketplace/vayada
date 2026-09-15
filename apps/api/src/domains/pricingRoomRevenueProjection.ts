import { parseStoredPricingQuote } from "@vayada/domain-booking";
import { isMinorAmount, pricingCurrencyScale, pricingObject } from "@vayada/domain-pms";
import type { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";

type Projection = Parameters<typeof persistDirectNightlyRevenueProjection>[2];
/** Pure conversion only. Charge evidence MUST come from current quote revalidation
 * on the caller's retained transaction. This does not authorize a booking write.
 * No aggregate discount or included charge is guessed into room/night amounts.
 * The persistence adapter must verify booking identity, currency, lifecycle and
 * initial/replay state under lock before calling the shared direct ledger sink. */
export function pricingRoomRevenueProjection(
  quoteValue: unknown,
  chargeValue: unknown,
): Projection | null {
  const quote = parseStoredPricingQuote(quoteValue);
  if (!quote || !pricingObject(chargeValue)) return null;
  const charges = chargeValue;
  const scale = pricingCurrencyScale(quote.stay.currency);
  if (
    scale === null ||
    scale > 4 ||
    charges.version !== "booking.fixed-charge-amounts.v1" ||
    charges.currency !== quote.stay.currency ||
    charges.requestKey !== quote.evidence.requestKey ||
    charges.sourceRevision !== quote.evidence.revisions.charges ||
    charges.basisEvidenceId !== quote.evidence.mandatoryChargeEvidenceId ||
    charges.includedChargeMinor !== "0" ||
    !isMinorAmount(charges.additionalChargeMinor) ||
    !Array.isArray(charges.charges) ||
    quote.evidence.lines.some((line) => line.kind === "discount" && line.amountMinor !== "0")
  )
    return null;
  let additional = 0n;
  const ids = new Set<string>();
  for (const charge of charges.charges) {
    if (
      !pricingObject(charge) ||
      typeof charge.id !== "string" ||
      !charge.id ||
      ids.has(charge.id) ||
      typeof charge.included !== "boolean" ||
      !isMinorAmount(charge.amountMinor) ||
      charge.basisEvidenceId !== charges.basisEvidenceId ||
      (charge.included && charge.amountMinor !== "0")
    )
      return null;
    ids.add(charge.id);
    if (!charge.included) additional += BigInt(charge.amountMinor);
  }
  if (
    additional.toString() !== charges.additionalChargeMinor ||
    additional !==
      quote.evidence.lines
        .filter((line) => line.kind === "charge")
        .reduce((n, line) => n + BigInt(line.amountMinor), 0n)
  )
    return null;
  const nights: Projection["nights"][number][] = [];
  for (const [index, selection] of quote.stay.rooms.entries()) {
    const room = quote.rooms.find((r) => r.selectionId === selection.selectionId);
    if (!room) return null;
    for (const night of room.nights) {
      const amount = BigInt(night.roomMinor),
        unit = 10n ** BigInt(scale);
      // The ledger uses NUMERIC(19,4), independently of booking total precision.
      if (amount * 10n ** BigInt(4 - scale) > 9999999999999999999n) return null;
      nights.push({
        stayDate: night.date,
        grossRoomAmount:
          scale === 0
            ? amount.toString()
            : `${amount / unit}.${(amount % unit).toString().padStart(scale, "0")}`,
        roomTypeId: selection.roomTypeId,
        roomPositions: [index + 1],
      });
    }
  }
  if (!nights.length) return null;
  return {
    roomTypeId: quote.stay.rooms[0].roomTypeId,
    nights,
    fingerprint: `pricing-room-revenue.v1:${quote.quoteId}:${quote.evidence.requestKey}`,
  };
}
