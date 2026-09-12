"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount, parseMinorInput } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const templateOf = (offer: Offer) => offer.price.kind === "independent" ? offer.price.calendar.base ?? offer.price.calendar.months[0]?.price ?? offer.price.calendar.seasons[0]?.price : null;
export function changeMonthPrice(room: PricingConfiguration, offerId: string, month: string, values: string[] | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent") throw new Error("Monthly prices belong to an independent offer.");
  if (!/^(?:[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month.");
  const calendar = offer.price.calendar, exists = calendar.months.some((entry) => entry.month === Number(month));
  if (values && exists) throw new Error("Clear the existing month price before adding a replacement.");
  if (!values && !exists) throw new Error("There is no price to clear for this month.");
  let next = calendar.months.filter((entry) => entry.month !== Number(month));
  if (values) {
    const template = templateOf(offer);
    if (!template) throw new Error("Set up recurring pricing before adding a monthly price.");
    if (values.length !== baseAmounts(template).length) throw new Error("Enter every required monthly price.");
    const amounts = Array.from(values, (value) => parseMinorInput(value, pricingCurrencyScale(room.currency)!));
    const price = template.mode === "flat" ? { ...template, amountMinor: amounts[0] } : template.mode === "per_person" ? { ...template, unitMinor: amounts[0] }
      : template.mode === "occupancy" ? { ...template, amountsMinor: amounts } : { ...template, baseMinor: amounts[0] };
    next = [...next, { month: Number(month), price }].sort((a, b) => a.month - b.month);
  }
  const price = { ...offer.price, calendar: { ...calendar, months: next } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("Check the monthly prices, including every adult-count adjustment.");
  return result;
}

export function PricingMonths({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [month, setMonth] = useState(""), [values, setValues] = useState<string[]>([]), [error, setError] = useState("");
  if (offer.price.kind !== "independent") return null;
  const template = templateOf(offer), scale = pricingCurrencyScale(room.currency)!;
  const pending = !!month || values.some(Boolean);
  const reset = () => { setMonth(""); setValues([]); setError(""); onPending(false); };
  const apply = (selected: string, amounts: string[] | null) => {
    if (disabled) return;
    try { onChange(changeMonthPrice(room, offer.id, selected, amounts)); if (amounts) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the monthly price."); }
  };
  const adjustments = (price: NonNullable<ReturnType<typeof templateOf>>) => price.mode === "included_guests" ? ` Includes ${price.baseGuests} adults; adjustments from this base: ${price.adjustments.map((value, index) => `${index + 1} adults ${value.kind === "percentage" ? `${value.basisPoints / 100}%` : `${value.deltaMinor.startsWith("-") ? "−" : "+"}${decimalAmount(value.deltaMinor.replace(/^-/, ""), scale)} ${room.currency}`}`).join("; ")}.` : "";
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Monthly prices · {label}</summary>
    <p className="mt-2 text-gray-600">Monthly prices repeat every year. Date prices take priority over seasons, seasons over months, and months over the base price. Weekday adjustments still apply to monthly prices. Child and meal charges are separate. Clearing restores the remaining rules; a missing fallback can make nights unavailable.</p>
    <ul className="my-3 space-y-2">{offer.price.calendar.months.map((entry) => <li key={entry.month} className="flex flex-wrap items-center gap-3">
      <span>{months[entry.month - 1]}: {baseAmounts(entry.price).map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`).join("; ")}.{adjustments(entry.price)}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={`Clear ${months[entry.month - 1]} price for ${label}`} onClick={() => apply(String(entry.month), null)}>Clear monthly price</button>
    </li>)}</ul>
    {!template ? <p>Set up recurring pricing before adding monthly prices. This offer currently has only date prices or no recurring price.</p> : <>
      <p className="mb-3">Monthly prices use this offer’s current pricing mode.{adjustments(template)}{template.mode === "included_guests" && " These included-adult settings stay the same when adding a month."}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>Month<select aria-label={`Month for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={month} onChange={(event) => { setMonth(event.target.value); setError(""); onPending(!!event.target.value || values.some(Boolean)); }}>
          <option value="">Choose…</option>{months.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
        </select></label>
        {baseAmounts(template).map(([name], index) => <label key={index}>{name} ({room.currency})<input aria-label={`Monthly ${name} for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values[index] ?? ""} onChange={(event) => {
          const next = Array.from({ length: baseAmounts(template).length }, (_, i) => i === index ? event.target.value : values[i] ?? ""); setValues(next); setError(""); onPending(!!month || next.some(Boolean));
        }} /></label>)}
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(month, values)}>Add monthly price</button>
      </div>
    </>}
    {pending && <><button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel month entry</button><p className="mt-2">Add or cancel this month entry before saving the draft.</p></>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
