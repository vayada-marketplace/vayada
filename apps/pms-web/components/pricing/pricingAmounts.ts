import { pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";

type Base = Extract<PricingConfiguration["offers"][number]["price"], { kind: "independent" }>["calendar"]["base"];
export function baseAmounts(base: Base): [string, string][] {
  if (!base) return [];
  if (base.mode === "occupancy") return base.amountsMinor.map((amount, index) => [`${index + 1} guest${index ? "s" : ""}`, amount]);
  if (base.mode === "per_person") return [["Per person", base.unitMinor]];
  if (base.mode === "included_guests") return [[`${base.baseGuests} guests included`, base.baseMinor]];
  return [["Per room", base.amountMinor]];
}
export function decimalAmount(minor: string, scale: number) {
  const digits = minor.padStart(scale + 1, "0");
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export function editedSnapshot(snapshot: PricingSnapshot, inputs: Record<string, string>): PricingSnapshot {
  const scale = pricingCurrencyScale(snapshot.currency)!;
  return { ...snapshot, ownerReferences: { finance: snapshot.ownerReferences.finance }, rooms: snapshot.rooms.map((room, ri) => ({ ...room,
    offers: room.offers.map((offer, oi) => {
      if (offer.price.kind !== "independent" || !offer.price.calendar.base) return offer;
      const base = offer.price.calendar.base, values = baseAmounts(base).map(([, minor], ai) => parseMinorInput(inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale), scale));
      const next = base.mode === "flat" ? { ...base, amountMinor: values[0] } : base.mode === "per_person" ? { ...base, unitMinor: values[0] }
        : base.mode === "occupancy" ? { ...base, amountsMinor: values } : { ...base, baseMinor: values[0] };
      return { ...offer, price: { ...offer.price, calendar: { ...offer.price.calendar, base: next } } };
    }),
  })) };
}

export function parseMinorInput(value: string, scale: number, allowZero = false) {
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${scale || 1}})?$`).test(value) || (!scale && value.includes("."))) throw new Error("Enter a valid price using a decimal point.");
  const [whole, fraction = ""] = value.split("."), minor = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (!allowZero && minor === "0") throw new Error("Enter a price greater than zero.");
  if (minor.length > 18) throw new Error("This price is too large.");
  return minor;
}
