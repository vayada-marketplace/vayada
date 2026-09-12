import { pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount, parseMinorInput } from "./pricingAmounts";
type Offer = PricingConfiguration["offers"][number];
export const recurringTemplate = (offer: Offer) => offer.price.kind === "independent" ? offer.price.calendar.base ?? offer.price.calendar.months[0]?.price ?? offer.price.calendar.seasons[0]?.price : null;
export function recurringPrice(offer: Offer, values: string[], currency: string) {
    const template = recurringTemplate(offer);
    if (!template) throw new Error("Set up recurring pricing before adding a recurring price.");
    if (values.length !== baseAmounts(template).length) throw new Error("Enter every required recurring price.");
    const amounts = Array.from(values, (value) => parseMinorInput(value, pricingCurrencyScale(currency)!));
    const price = template.mode === "flat" ? { ...template, amountMinor: amounts[0] } : template.mode === "per_person" ? { ...template, unitMinor: amounts[0] }
      : template.mode === "occupancy" ? { ...template, amountsMinor: amounts } : { ...template, baseMinor: amounts[0] };
    return price;
}
export const recurringAdjustments = (price: NonNullable<ReturnType<typeof recurringTemplate>>, currency: string, scale: number) => price.mode === "included_guests" ? ` Includes ${price.baseGuests} adults; adjustments from this base: ${price.adjustments.map((value, index) => `${index + 1} adults ${value.kind === "percentage" ? `${value.basisPoints / 100}%` : `${value.deltaMinor.startsWith("-") ? "−" : "+"}${decimalAmount(value.deltaMinor.replace(/^-/, ""), scale)} ${currency}`}`).join("; ")}.` : "";
