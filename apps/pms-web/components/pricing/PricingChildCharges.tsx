"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { decimalAmount, parseMinorInput } from "./pricingAmounts";

export function changeChildCharges(room: PricingConfiguration, amounts: readonly string[]): PricingConfiguration {
  if (amounts.length !== room.children.bands.length) throw new Error("Enter a nightly charge for every existing child age band.");
  const scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new Error("The pricing currency is unavailable. Reload pricing.");
  const bands = room.children.bands.map((band, index) => ({ ...band, nightlyMinor: parseMinorInput(amounts[index], scale, true) }));
  const result = parsePricingConfiguration({ ...room, children: { ...room.children, bands } });
  if (!result) throw new Error("The child pricing configuration is invalid. Reload pricing.");
  return result;
}

export function PricingChildCharges({ room, label, disabled, onChange, onPending }: { room: PricingConfiguration; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<string[] | null>(null), [error, setError] = useState("");
  const scale = pricingCurrencyScale(room.currency)!;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="border-b p-5 text-sm"><summary className="cursor-pointer">Child nightly charges · {label}</summary>
    <p className="mt-2 text-gray-600">These charges apply per child per night across every offer in this room, separately from meal charges. Use each child’s age at check-in. Guests aged {room.children.adultFromAge} or older use adult pricing. Enter 0 for no child nightly charge.</p>
    <ul className="mt-3 space-y-3">{room.children.bands.map((band, index) => <li key={band.fromAge}>
      <p>Ages {band.fromAge}–{band.throughAge}: {decimalAmount(band.nightlyMinor, scale)} {room.currency} per child per night. {band.countsTowardCapacity ? "Counts toward total room capacity." : "Does not count toward total room capacity."} The room’s child limit still applies.</p>
      {entry && <label className="mt-2 block">Nightly charge ({room.currency})<input aria-label={`Child charge ages ${band.fromAge}–${band.throughAge} for ${label}`} inputMode="decimal" className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry[index]} onChange={(event) => { setEntry(entry.map((value, i) => i === index ? event.target.value : value)); setError(""); }} /></label>}
    </li>)}</ul>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
      if (disabled) return; setEntry(room.children.bands.map((band) => decimalAmount(band.nightlyMinor, scale))); setError(""); onPending(true);
    }}>Edit child charges</button> : <>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeChildCharges(room, entry)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change child charges."); }
      }}>Apply child charges</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel child charges</button></div>
      <p className="mt-2">Apply or cancel this edit before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
