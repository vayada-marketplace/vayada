"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { IncludedPricing, includedPrice, type IncludedInput } from "./IncludedPricing";
import { decimalAmount } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeIncludedAdjustments(room: PricingConfiguration, offerId: string, entry: IncludedInput, baseValue: string): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent" || offer.price.calendar.base?.mode !== "included_guests") throw new Error("Choose an offer with an included-adult base price.");
  const scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new Error("The pricing currency is invalid.");
  const base = includedPrice(entry, baseValue, room.capacity.adults, scale);
  const price = { ...offer.price, calendar: { ...offer.price.calendar, base } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, price } : value) });
  if (!result) throw new Error("The included-adult pricing configuration is invalid.");
  return result;
}

export function PricingIncludedAdjustments({ room, offer, label, baseValue, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; baseValue?: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<IncludedInput | null>(null), [error, setError] = useState("");
  if (offer.price.kind !== "independent" || offer.price.calendar.base?.mode !== "included_guests") return null;
  const base = offer.price.calendar.base, scale = pricingCurrencyScale(room.currency)!;
  const amount = baseValue ?? decimalAmount(base.baseMinor, scale);
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Included-adult adjustments · {label}</summary>
    <p className="mt-2">The base price includes {base.baseGuests} adult{base.baseGuests === 1 ? "" : "s"}. Adjustments apply to the base adult room price. Monthly and seasonal prices keep their own included counts and adjustments; final date prices bypass the base. Linked offers follow the resulting adult room price. Child and meal charges are separate.</p>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return;
      setEntry({ adults: String(base.baseGuests), adjustments: base.adjustments.map((adjustment) => {
        const minor = adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
        return { kind: adjustment.kind, value: `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? scale : 2)}` };
      }) }); setError(""); onPending(true);
    }}>Edit included-adult adjustments</button> : <div className="mt-3 space-y-3">
      <p>Base price used: {amount} {room.currency}. To change it, cancel this edit and update the base price first. Changing the included count clears the adjustments.</p>
      <IncludedPricing value={entry} capacity={room.capacity.adults} disabled={disabled} onChange={(value) => { setEntry(value); setError(""); }} />
      <div className="flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeIncludedAdjustments(room, offer.id, entry, amount)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change included-adult adjustments."); }
      }}>Apply included-adult adjustments</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel included-adult adjustments</button></div>
      <p>Apply or cancel before editing other rules or saving the draft.</p>
    </div>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
