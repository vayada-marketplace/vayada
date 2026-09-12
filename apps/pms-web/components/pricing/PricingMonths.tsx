"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount } from "./pricingAmounts";

import { recurringTemplate, recurringPrice, recurringAdjustments } from "./recurringPricingInputs";

import { IncludedPricing, includedInput, includedPrice, type IncludedInput } from "./IncludedPricing";

type Offer = PricingConfiguration["offers"][number];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function changeMonthPrice(room: PricingConfiguration, offerId: string, month: string, values: string[] | null, replace = false, included: IncludedInput | null = null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent") throw new Error("Monthly prices belong to an independent offer.");
  if (!/^(?:[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month.");
  const calendar = offer.price.calendar, existing = calendar.months.find((entry) => entry.month === Number(month)), exists = !!existing;
  if (replace && (!existing || !values)) throw new Error("Choose an existing month price to edit.");
  if (values && exists && !replace) throw new Error("Clear the existing month price or use Edit monthly price.");
  if (!values && !exists) throw new Error("There is no price to clear for this month.");
  let next = calendar.months.filter((entry) => entry.month !== Number(month));
  if (values) {
    if (included && (!replace || existing?.price.mode !== "included_guests" || values.length !== 1)) throw new Error("Choose an existing included-adult month price.");
    const price = included ? includedPrice(included, values[0], room.capacity.adults, pricingCurrencyScale(room.currency)!) : recurringPrice(offer, values, room.currency, replace ? existing!.price : recurringTemplate(offer));
    next = [...next, { month: Number(month), price }].sort((a, b) => a.month - b.month);
  }
  const price = { ...offer.price, calendar: { ...calendar, months: next } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("Check the monthly prices, including every adult-count adjustment.");
  return result;
}

export function PricingMonths({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [included, setIncluded] = useState<IncludedInput | null>(null);
  const [month, setMonth] = useState(""), [values, setValues] = useState<string[]>([]), [error, setError] = useState(""), [editing, setEditing] = useState(false);
  if (offer.price.kind !== "independent") return null;
  const template = editing ? offer.price.calendar.months.find((entry) => entry.month === Number(month))?.price : recurringTemplate(offer), scale = pricingCurrencyScale(room.currency)!;
  const pending = !!month || values.some(Boolean);
  const reset = () => { setMonth(""); setValues([]); setIncluded(null); setEditing(false); setError(""); onPending(false); };
  const apply = (selected: string, amounts: string[] | null) => {
    if (disabled || (!amounts && pending)) return;
    try { onChange(changeMonthPrice(room, offer.id, selected, amounts, editing, amounts ? included : null)); if (amounts) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the monthly price."); }
  };

  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Monthly prices · {label}</summary>
    <p className="mt-2 text-gray-600">Monthly prices repeat every year. Date prices take priority over seasons, seasons over months, and months over the base price. Weekday adjustments still apply to monthly prices. Child and meal charges are separate. Clearing restores the remaining rules; a missing fallback can make nights unavailable.</p>
    <ul className="my-3 space-y-2">{offer.price.calendar.months.map((entry) => <li key={entry.month} className="flex flex-wrap items-center gap-3">
      <span>{months[entry.month - 1]}: {baseAmounts(entry.price).map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`).join("; ")}.{recurringAdjustments(entry.price, room.currency, scale)}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Edit ${months[entry.month - 1]} price for ${label}`} onClick={() => {
        if (disabled || pending) return;
        setIncluded(entry.price.mode === "included_guests" ? includedInput(entry.price, scale) : null); setEditing(true); setMonth(String(entry.month)); setValues(baseAmounts(entry.price).map(([, minor]) => decimalAmount(minor, scale))); setError(""); onPending(true);
      }}>Edit monthly price</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Clear ${months[entry.month - 1]} price for ${label}`} onClick={() => apply(String(entry.month), null)}>Clear monthly price</button>
    </li>)}</ul>
    {!template ? <p>Set up recurring pricing before adding monthly prices. This offer currently has only date prices or no recurring price.</p> : <>
      <p className="mb-3">{editing ? "Edit this month’s prices and included-adult settings while keeping its pricing mode. Other months and rules remain unchanged." : "Monthly prices use this offer’s current pricing mode."}{recurringAdjustments(template, room.currency, scale)}{!editing && template.mode === "included_guests" && " These included-adult settings stay the same when adding a month."}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>Month<select aria-label={`Month for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled || editing} value={month} onChange={(event) => { if (disabled || editing) return; setMonth(event.target.value); setError(""); onPending(!!event.target.value || values.some(Boolean)); }}>
          <option value="">Choose…</option>{months.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
        </select></label>
        {baseAmounts(included && template.mode === "included_guests" ? { ...template, baseGuests: Number(included.adults) || template.baseGuests } : template).map(([name], index) => <label key={index}>{name} ({room.currency})<input aria-label={`Monthly ${name} for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values[index] ?? ""} onChange={(event) => {
          const next = Array.from({ length: baseAmounts(template).length }, (_, i) => i === index ? event.target.value : values[i] ?? ""); setValues(next); setError(""); onPending(!!month || next.some(Boolean));
        }} /></label>)}
        {included && <div className="w-full"><p>The base amount above belongs to this monthly price. Changing the included count clears its adjustments.</p><IncludedPricing value={included} label={`${label} monthly price`} capacity={room.capacity.adults} disabled={disabled} onChange={(next) => { if (disabled) return; setIncluded(next); setError(""); }} /></div>}
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(month, values)}>{editing ? "Apply monthly price" : "Add monthly price"}</button>
      </div>
    </>}
    {pending && <><button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel month entry</button><p className="mt-2">{editing ? "Apply" : "Add"} or cancel this month entry before saving the draft.</p></>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
