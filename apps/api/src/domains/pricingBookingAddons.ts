import { isDeepStrictEqual } from "node:util";
import { parseAddonEconomicTerms, replacementStayKey } from "@vayada/domain-booking";
import { isMinorAmount, pricingCurrencyScale, pricingDate } from "@vayada/domain-pms";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";

type CurrentQuote = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;
/** Exact representation for existing NUMERIC(15,2) columns, including zero-decimal currencies. */
function decimal(minor: string, scale: number): string | null {
  if (!isMinorAmount(minor)) return null;
  const amount = BigInt(minor),
    divisor = 10n ** BigInt(Math.max(scale - 2, 0));
  if (amount % divisor) return null;
  const cents = (amount / divisor) * 10n ** BigInt(Math.max(2 - scale, 0));
  if (cents > 999999999999999n) return null;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Pure persistence projection of successful pre-mutation evidence from the caller's
 * retained READ COMMITTED transaction. Never recaptures owners or recomputes prices.
 * Caller binds the resulting rows to its scoped booking and preserves atomic rollback. */
export function projectPricingBookingAddons(current: CurrentQuote) {
  const { quote, calculation, scope } = current,
    component = calculation.addons;
  const scale = pricingCurrencyScale(quote.stay.currency);
  const quotedLines = quote.evidence.lines.filter((line) => line.kind === "addon");
  if (
    current.kind !== "current_quote_price" ||
    scope.propertyId !== quote.stay.propertyId ||
    scale === null ||
    component.kind !== "addon_components" ||
    component.evaluatorVersion !== "booking.addon-components.v2" ||
    component.currency !== quote.stay.currency ||
    component.sourceRevision !== quote.evidence.revisions.addons ||
    component.requestKey !== replacementStayKey(quote.stay) ||
    !isMinorAmount(component.totalMinor) ||
    component.lines.length !== quote.stay.addons.length ||
    quotedLines.length !== component.lines.length
  )
    return null;
  const rows = [],
    seen = new Set<string>();
  let total = 0n;
  for (const [index, line] of component.lines.entries()) {
    const definition = line.definition;
    const selected = quote.stay.addons.find((addon) => addon.id.toLowerCase() === definition.id);
    const economics = parseAddonEconomicTerms(definition);
    const nightly =
      definition.pricingModel === "per_night" || definition.pricingModel === "per_guest_night";
    if (
      !selected ||
      selected.version !== "addon-selection.v2" ||
      seen.has(definition.id) ||
      !economics ||
      economics.partnerCommissionRate !== definition.partnerCommissionRate ||
      definition.currency !== component.currency ||
      line.quantity !== selected.quantity ||
      !isDeepStrictEqual(line.people, selected.people) ||
      !isMinorAmount(line.amountMinor) ||
      quotedLines[index]?.amountMinor !== line.amountMinor ||
      !line.dates?.length ||
      new Set(line.dates).size !== line.dates.length ||
      line.dates.some(
        (date) =>
          !pricingDate(date) ||
          date < quote.stay.checkIn ||
          (nightly ? date >= quote.stay.checkOut : date > quote.stay.checkOut),
      ) ||
      (!nightly && line.dates.length !== 1) ||
      line.daysMultiplier !== (nightly ? line.dates.length : 1) ||
      (selected.dates !== null && !isDeepStrictEqual([...selected.dates].sort(), line.dates))
    )
      return null;
    seen.add(definition.id);
    // Existing per-night owner lines use equal service-day amounts. Split that resolved
    // amount exactly; do not multiply the definition's unit price or round residual cents.
    const amount = BigInt(line.amountMinor),
      days = BigInt(line.dates.length);
    if (amount % days !== 0n) return null;
    const amountMinor = (amount / days).toString(),
      totalAmount = decimal(amountMinor, scale);
    if (totalAmount === null) return null;
    total += amount;
    for (const serviceDate of line.dates)
      rows.push({
        addonDefinitionId: definition.id,
        addonSnapshot: structuredClone({
          version: "booking.pricing-addon-selection.v1",
          pricingQuoteId: quote.quoteId,
          name: definition.name,
          selection: selected,
          definition,
          sourceRevision: component.sourceRevision,
          serviceDate,
          lineAmountMinor: line.amountMinor,
          amountMinor,
        }),
        quantity: line.quantity,
        serviceDate,
        totalAmount,
        currency: component.currency,
        ownershipKind: economics.ownershipKind,
        partnerCommissionRate: economics.partnerCommissionRate,
      });
  }
  return total.toString() === component.totalMinor ? rows : null;
}
