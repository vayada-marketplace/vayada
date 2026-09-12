"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount, parseMinorInput } from "./pricingAmounts";
type Offer = PricingConfiguration["offers"][number];
const datesOf = (offer: Offer) => offer.price.kind === "linked" ? offer.price.dateOverrides : offer.price.calendar.dates;
export function changeDatePrice(room: PricingConfiguration, offerId: string, date: string, amount: string | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer) throw new Error("The offer is unavailable. Reload pricing.");
  const dates = datesOf(offer), exists = dates.some((entry) => entry.date === date);
  if (amount !== null && exists) throw new Error("Clear the existing price for this date before adding a replacement.");
  if (amount === null && !exists) throw new Error("There is no override to clear for this date.");
  const nextDates = amount === null ? dates.filter((entry) => entry.date !== date) : [...dates, { date, price: { mode: "flat" as const, amountMinor: parseMinorInput(amount, pricingCurrencyScale(room.currency)!) } }];
  const price = offer.price.kind === "linked" ? { ...offer.price, dateOverrides: nextDates } : { ...offer.price, calendar: { ...offer.price.calendar, dates: nextDates } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("Enter a valid calendar date and room price.");
  return result;
}
export function PricingDates({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [date, setDate] = useState(""), [amount, setAmount] = useState(""), [error, setError] = useState("");
  const reset = () => { setDate(""); setAmount(""); setError(""); onPending(false); };
  const apply = (day: string, value: string | null) => {
    if (disabled) return;
    try { onChange(changeDatePrice(room, offer.id, day, value)); if (value !== null) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the date price."); }
  };
  const scale = pricingCurrencyScale(room.currency)!;
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Date-specific prices · {label}</summary>
    <p className="mt-2 text-gray-600">A date price replaces the adult room tariff for that night. Child supplements and meals still apply. For linked offers, this replaces the parent price and this offer’s adjustment on that date. Clearing restores the normal calendar or parent rules; an unpriced fallback can be unavailable.</p>
    <ul className="my-3 space-y-2">{datesOf(offer).map((entry) => <li key={entry.date} className="flex flex-wrap items-center gap-3"><span>{entry.date}: {baseAmounts(entry.price).map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`).join("; ")}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={`Clear ${entry.date} price for ${label}`} onClick={() => apply(entry.date, null)}>Clear date price</button></li>)}</ul>
    <div className="flex flex-wrap items-end gap-3">
      <label>Date (YYYY-MM-DD)<input type="text" placeholder="YYYY-MM-DD" aria-label={`Override date for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" disabled={disabled} value={date} onChange={(event) => { setDate(event.target.value); setError(""); onPending(!!event.target.value || !!amount); }} /></label>
      <label>Room price ({room.currency})<input aria-label={`Date room price for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={amount} onChange={(event) => { setAmount(event.target.value); setError(""); onPending(!!date || !!event.target.value); }} /></label>
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(date, amount)}>Add date price</button>
      {(date || amount) && <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel date entry</button>}
    </div>
    {(date || amount) && <p className="mt-2">Add or cancel this date entry before saving the draft.</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
