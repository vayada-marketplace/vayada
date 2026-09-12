"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount, parseMinorInput } from "./pricingAmounts";
import { recurringPrice, recurringAdjustments, recurringTemplate } from "./recurringPricingInputs";
import { IncludedPricing, includedInput, includedPrice, type IncludedInput } from "./IncludedPricing";
type Offer = PricingConfiguration["offers"][number];
const datesOf = (offer: Offer) => offer.price.kind === "linked" ? offer.price.dateOverrides : offer.price.calendar.dates;
export function changeDatePrice(room: PricingConfiguration, offerId: string, date: string, amount: string | string[] | null, useRecurring = false, included: IncludedInput | null = null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer) throw new Error("The offer is unavailable. Reload pricing.");
  const dates = datesOf(offer), existing = dates.find((entry) => entry.date === date), exists = !!existing;
  const editing = Array.isArray(amount) && !useRecurring;
  if (useRecurring && (!Array.isArray(amount) || !recurringTemplate(offer))) throw new Error("Choose an independent offer with recurring pricing.");
  if (editing && !existing) throw new Error("Choose an existing date price to edit.");
  if (amount !== null && exists && !editing) throw new Error("Clear the existing price for this date before adding a replacement.");
  if (amount === null && !exists) throw new Error("There is no override to clear for this date.");
  if (included && (!editing || existing?.price.mode !== "included_guests" || !Array.isArray(amount) || amount.length !== 1)) throw new Error("Choose an existing included-adult date price.");
  const nextDates = useRecurring && Array.isArray(amount) ? [...dates, { date, price: recurringPrice(offer, amount, room.currency) }] : Array.isArray(amount) ? dates.map((entry) => entry.date === date ? { ...entry, price: included ? includedPrice(included, amount[0], room.capacity.adults, pricingCurrencyScale(room.currency)!) : recurringPrice(offer, amount, room.currency, existing!.price) } : entry) : amount === null ? dates.filter((entry) => entry.date !== date) : [...dates, { date, price: { mode: "flat" as const, amountMinor: parseMinorInput(amount, pricingCurrencyScale(room.currency)!) } }];
  const price = offer.price.kind === "linked" ? { ...offer.price, dateOverrides: nextDates } : { ...offer.price, calendar: { ...offer.price.calendar, dates: nextDates } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("Enter a valid calendar date and room price.");
  return result;
}
export function PricingDates({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [included, setIncluded] = useState<IncludedInput | null>(null);
  const [date, setDate] = useState(""), [amounts, setAmounts] = useState<string[]>([]), [error, setError] = useState(""), [editing, setEditing] = useState(false), [useRecurring, setUseRecurring] = useState(false);
  const pending = useRecurring || editing || !!date || amounts.some(Boolean);
  const reset = () => { setDate(""); setAmounts([]); setIncluded(null); setEditing(false); setUseRecurring(false); setError(""); onPending(false); };
  const apply = (day: string, value: string | string[] | null) => {
    if (disabled || (value === null && pending)) return;
    try { onChange(changeDatePrice(room, offer.id, day, value, !editing && useRecurring, value !== null ? included : null)); if (value !== null) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the date price."); }
  };
  const scale = pricingCurrencyScale(room.currency)!;
  const recurring = recurringTemplate(offer);
  const template = editing ? datesOf(offer).find((entry) => entry.date === date)?.price : useRecurring ? recurring : null;
  const fields = template ? baseAmounts(included && template.mode === "included_guests" ? { ...template, baseGuests: Number(included.adults) || template.baseGuests } : template) : [["Per room", ""]];
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Date-specific prices · {label}</summary>
    <p className="mt-2 text-gray-600">A date price replaces the adult room tariff for that night. Child supplements and meals still apply. For linked offers, this replaces the parent price and this offer’s adjustment on that date. Clearing restores the normal calendar or parent rules; an unpriced fallback can be unavailable.</p>
    <ul className="my-3 space-y-2">{datesOf(offer).map((entry) => <li key={entry.date} className="flex flex-wrap items-center gap-3"><span>{entry.date}: {baseAmounts(entry.price).map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`).join("; ")}{recurringAdjustments(entry.price, room.currency, scale)}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Edit ${entry.date} price for ${label}`} onClick={() => {
        if (disabled || pending) return;
        setIncluded(entry.price.mode === "included_guests" ? includedInput(entry.price, scale) : null); setEditing(true); setDate(entry.date); setAmounts(baseAmounts(entry.price).map(([, minor]) => decimalAmount(minor, scale))); setError(""); onPending(true);
      }}>Edit date price</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Clear ${entry.date} price for ${label}`} onClick={() => apply(entry.date, null)}>Clear date price</button></li>)}</ul>
    {editing && template && <p className="mb-3">Edit this date’s amounts and included-adult settings while keeping its date and pricing mode.{recurringAdjustments(template, room.currency, scale)}</p>}
    {!editing && <>
      {recurring && <label className="mb-3 block">New date pricing<select aria-label={`New date pricing for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={useRecurring ? "recurring" : "flat"} onChange={(event) => {
        if (disabled) return; const next = event.target.value === "recurring"; setUseRecurring(next); setAmounts([]); setError(""); onPending(next || !!date);
      }}><option value="flat">One final room price</option><option value="recurring">Use this offer’s recurring pricing mode</option></select></label>}
      <p className="mb-3">{useRecurring && recurring ? `Enter a final date price using the displayed recurring pricing settings.${recurringAdjustments(recurring, room.currency, scale)}` : "New date prices use one final room price for every adult count."} Final date prices bypass weekday adjustments.</p>
    </>}
    <div className="flex flex-wrap items-end gap-3">
      <label>Date (YYYY-MM-DD)<input type="text" placeholder="YYYY-MM-DD" aria-label={`Override date for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" disabled={disabled || editing} value={date} onChange={(event) => { if (disabled || editing) return; setDate(event.target.value); setError(""); onPending(useRecurring || !!event.target.value || amounts.some(Boolean)); }} /></label>
      {fields.map(([name], index) => <label key={index}>{name} ({room.currency})<input aria-label={`${name === "Per room" ? "Date room price" : `Date ${name}`} for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={amounts[index] ?? ""} onChange={(event) => {
        const next = Array.from({ length: fields.length }, (_, i) => i === index ? event.target.value : amounts[i] ?? ""); setAmounts(next); setError(""); onPending(useRecurring || editing || !!date || next.some(Boolean));
      }} /></label>)}
      {included && <div className="w-full"><p>The base amount above belongs only to this date price. Changing the included count clears its adjustments.</p><IncludedPricing value={included} label={`${label} date price`} capacity={room.capacity.adults} disabled={disabled} onChange={(next) => { if (disabled) return; setIncluded(next); setError(""); }} /></div>}
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(date, editing || useRecurring ? amounts : amounts[0] ?? "")}>{editing ? "Apply date price" : "Add date price"}</button>
      {pending && <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel date entry</button>}
    </div>
    {pending && <p className="mt-2">{editing ? "Apply" : "Add"} or cancel this date entry before saving the draft.</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
