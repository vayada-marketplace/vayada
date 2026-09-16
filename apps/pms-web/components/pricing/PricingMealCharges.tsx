"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { decimalAmount, parseMinorInput } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeMealCharges(room: PricingConfiguration, offerId: string, amounts: readonly string[]): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.meal.kind === "room_only") throw new Error("Choose an existing meal-inclusive offer.");
  const charge = offer.meal.charge, scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new Error("The pricing currency is unavailable. Reload pricing.");
  if (amounts.length !== (charge.kind === "room" ? 1 : room.children.bands.length + 1)) throw new Error("Enter every meal charge for the existing charging model.");
  const values = Array.from(amounts, (amount) => parseMinorInput(amount, scale, true));
  const next = charge.kind === "room" ? { ...charge, amountMinor: values[0] } : { ...charge, adultMinor: values[0], childBandAmountsMinor: values.slice(1) };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, meal: { ...value.meal, charge: next } } : value) });
  if (!result) throw new Error("The meal pricing configuration is invalid. Reload pricing.");
  return result;
}

export function PricingMealCharges({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<string[] | null>(null), [error, setError] = useState("");
  if (offer.meal.kind === "room_only") return <p className="sm:col-span-2 text-sm">Meals · {label}: room only, no meal charge.</p>;
  const charge = offer.meal.charge, scale = pricingCurrencyScale(room.currency)!;
  const values = charge.kind === "room" ? [charge.amountMinor] : [charge.adultMinor, ...charge.childBandAmountsMinor];
  const labels = charge.kind === "room" ? ["Per room"] : ["Per adult", ...room.children.bands.map((band) => `Per child ages ${band.fromAge}–${band.throughAge}`)];
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Meal charges · {label}</summary>
    <p className="mt-2">{offer.meal.kind.replaceAll("_", " ")} · charged per {charge.kind === "room" ? "room" : "person"} per night.</p>
    <p className="mt-2 text-gray-600">This offer’s meal charge is added once, separately from adult room prices and child nightly supplements. It does not inherit the parent offer’s meal charge. {charge.kind === "person" && <>Child ages are measured at check-in; guests aged {room.children.adultFromAge} or older use the adult amount. </>} Enter 0 for no additional meal charge.</p>
    <ul className="mt-3 space-y-3">{values.map((minor, index) => <li key={labels[index]}>
      <p>{labels[index]}: {decimalAmount(minor, scale)} {room.currency} per night.</p>
      {entry && <label className="mt-2 block">{labels[index]} ({room.currency})<input aria-label={`Meal charge ${labels[index]} for ${label}`} inputMode="decimal" className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry[index]} onChange={(event) => { setEntry(entry.map((value, i) => i === index ? event.target.value : value)); setError(""); }} /></label>}
    </li>)}</ul>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
      if (disabled) return; setEntry(values.map((minor) => decimalAmount(minor, scale))); setError(""); onPending(true);
    }}>Edit meal charges</button> : <>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeMealCharges(room, offer.id, entry)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change meal charges."); }
      }}>Apply meal charges</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel meal charges</button></div>
      <p className="mt-2">Apply or cancel this edit before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
