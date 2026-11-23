import { parseStoredPricingQuote } from "@vayada/domain-booking";
import {
  isMinorAmount,
  pricingAmountStep,
  pricingCurrencyScale,
  pricingObject,
} from "@vayada/domain-pms";
import { splitByWeight } from "./pricingRetainedRevenue.js";
import type { persistDirectNightlyRevenueProjection } from "./stripeBookingSettlement.js";

type Projection = Parameters<typeof persistDirectNightlyRevenueProjection>[2];
/** Pure conversion only. Charge evidence MUST come from current quote revalidation
 * on the caller's retained transaction. This does not authorize a booking write.
 * Discounts come off the room nights (VAY-2566), in proportion to their prices, largest
 * remainder first, in whole currency steps (whole rupiah for IDR): a room's own (last-minute)
 * discount off that room's nights, then a code's discount off the nights of the rooms it applies
 * to (`code.eligibleSelectionIds` from the quote's stored calculation). Its share for add-ons
 * comes off those nights too (Flamur, 2026-11-23); what they can't take, the other rooms' nights
 * do. An included charge is never guessed into room/night amounts: such quotes are refused.
 * The persistence adapter must verify booking identity, currency, lifecycle and
 * initial/replay state under lock before calling the shared direct ledger sink. */
export function pricingRoomRevenueProjection(
  quoteValue: unknown,
  chargeValue: unknown,
  codeValue?: unknown,
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
    quote.evidence.lines.some(
      (line) =>
        line.kind === "discount" &&
        line.selectionId !== null &&
        !quote.stay.rooms.some((room) => room.selectionId === line.selectionId),
    )
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
  const step = BigInt(pricingAmountStep(quote.stay.currency));
  const share = (amount: bigint, weights: bigint[]) => {
    const unit = [amount, ...weights].every((v) => v % step === 0n) ? step : 1n;
    return splitByWeight(
      amount / unit,
      weights.map((weight) => weight / unit),
    ).map((part) => part * unit);
  };
  const rows: {
    selectionId: string;
    roomTypeId: string;
    position: number;
    date: string;
    amount: bigint;
  }[] = [];
  for (const [index, selection] of quote.stay.rooms.entries()) {
    const room = quote.rooms.find((r) => r.selectionId === selection.selectionId);
    if (!room) return null;
    const prices = room.nights.map((night) => BigInt(night.roomMinor));
    const discount = quote.evidence.lines
      .filter((line) => line.kind === "discount" && line.selectionId === selection.selectionId)
      .reduce((n, line) => n + BigInt(line.amountMinor), 0n);
    if (discount > prices.reduce((n, price) => n + price, 0n)) return null;
    const shares = share(discount, prices);
    for (const [nightIndex, night] of room.nights.entries())
      rows.push({
        selectionId: selection.selectionId,
        roomTypeId: selection.roomTypeId,
        position: index + 1,
        date: night.date,
        amount: prices[nightIndex] - shares[nightIndex],
      });
  }
  let code = quote.evidence.lines
    .filter((line) => line.kind === "discount" && line.selectionId === null)
    .reduce((n, line) => n + BigInt(line.amountMinor), 0n);
  if (code > 0n) {
    const eligible = pricingObject(codeValue) ? codeValue.eligibleSelectionIds : null;
    if (
      !Array.isArray(eligible) ||
      !eligible.length ||
      !eligible.every((id) => quote.stay.rooms.some((room) => room.selectionId === id))
    )
      return null;
    for (const group of [
      rows.filter((row) => eligible.includes(row.selectionId)),
      rows.filter((row) => !eligible.includes(row.selectionId)),
    ]) {
      const total = group.reduce((n, row) => n + row.amount, 0n);
      const taken = code < total ? code : total;
      share(
        taken,
        group.map((row) => row.amount),
      ).forEach((part, i) => (group[i].amount -= part));
      code -= taken;
    }
    if (code > 0n) return null;
  }
  const nights: Projection["nights"][number][] = [];
  for (const row of rows) {
    const amount = row.amount,
      unit = 10n ** BigInt(scale);
    // The ledger uses NUMERIC(19,4), independently of booking total precision.
    if (amount * 10n ** BigInt(4 - scale) > 9999999999999999999n) return null;
    nights.push({
      stayDate: row.date,
      grossRoomAmount:
        scale === 0
          ? amount.toString()
          : `${amount / unit}.${(amount % unit).toString().padStart(scale, "0")}`,
      roomTypeId: row.roomTypeId,
      roomPositions: [row.position],
    });
  }
  if (!nights.length) return null;
  return {
    roomTypeId: quote.stay.rooms[0].roomTypeId,
    nights,
    fingerprint: `pricing-room-revenue.v1:${quote.quoteId}:${quote.evidence.requestKey}`,
  };
}
