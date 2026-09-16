"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { decimalAmount, parseAdjustmentInput } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export function changeWeekdayPrice(room: PricingConfiguration, offerId: string, day: string, input: { kind: string; value: string } | null, replace = false): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent") throw new Error("Weekday adjustments belong to an independent offer.");
  if (!/^[0-6]$/.test(day)) throw new Error("Choose a weekday.");
  const weekdays = offer.price.calendar.weekdays, exists = weekdays.some((entry) => entry.day === Number(day));
  if (replace && (!exists || !input)) throw new Error("Choose an existing weekday adjustment to edit.");
  if (input && exists && !replace) throw new Error("Clear the existing weekday adjustment before adding a replacement.");
  if (!input && !exists) throw new Error("There is no adjustment to clear for this weekday.");
  let next = weekdays.filter((entry) => entry.day !== Number(day));
  if (input) {
    const adjustment = parseAdjustmentInput(input, room.currency);
    next = [...next, { day: Number(day), adjustment }].sort((a, b) => a.day - b.day);
  }
  const price = { ...offer.price, calendar: { ...offer.price.calendar, weekdays: next } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("This adjustment is outside the supported range.");
  return result;
}

export function PricingWeekdays({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState({ day: "", kind: "", value: "" }), [error, setError] = useState(""), [editing, setEditing] = useState(false);
  if (offer.price.kind !== "independent") return null;
  const pending = !!(entry.day || entry.kind || entry.value);
  const update = (next: typeof entry) => { setEntry(next); setError(""); onPending(!!(next.day || next.kind || next.value)); };
  const reset = () => { setEditing(false); update({ day: "", kind: "", value: "" }); };
  const apply = (day: string, input: { kind: string; value: string } | null) => {
    if (disabled || (!input && pending)) return;
    try { onChange(changeWeekdayPrice(room, offer.id, day, input, editing)); if (input) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the weekday adjustment."); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Weekday adjustments · {label}</summary>
    <p className="mt-2 text-gray-600">Adjust the adult room price after base, month or season pricing. Final date prices bypass weekday adjustments. Child and meal charges are added separately. Use a minus sign for a reduction; 0 keeps the same price. A reduction that leaves no positive room price makes that night unavailable.</p>
    <ul className="my-3 space-y-2">{offer.price.calendar.weekdays.map(({ day, adjustment }) => <li key={day} className="flex flex-wrap items-center gap-3">
      <span>{weekdayNames[day]}: {adjustment.kind === "percentage" ? `${adjustment.basisPoints / 100}%` : `${adjustment.deltaMinor.startsWith("-") ? "−" : "+"}${decimalAmount(adjustment.deltaMinor.replace(/^-/, ""), pricingCurrencyScale(room.currency)!)} ${room.currency}`}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Edit ${weekdayNames[day]} adjustment for ${label}`} onClick={() => {
        if (disabled || pending) return;
        const minor = adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
        setEditing(true); update({ day: String(day), kind: adjustment.kind, value: `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? pricingCurrencyScale(room.currency)! : 2)}` });
      }}>Edit weekday adjustment</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Clear ${weekdayNames[day]} adjustment for ${label}`} onClick={() => apply(String(day), null)}>Clear weekday adjustment</button>
    </li>)}</ul>
    <div className="flex flex-wrap items-end gap-3">
      <label>Weekday<select aria-label={`Weekday for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled || editing} value={entry.day} onChange={(event) => { if (!disabled && !editing) update({ ...entry, day: event.target.value }); }}>
        <option value="">Choose…</option>{weekdayNames.map((name, day) => <option key={day} value={day}>{name}</option>)}
      </select></label>
      <label>Adjustment type<select aria-label={`Weekday adjustment type for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={entry.kind} onChange={(event) => update({ ...entry, kind: event.target.value, value: "" })}>
        <option value="">Choose…</option><option value="fixed">Amount in {room.currency}</option><option value="percentage">Percentage</option>
      </select></label>
      <label>Adjustment {entry.kind === "percentage" ? "(%)" : `(${room.currency})`}<input aria-label={`Weekday adjustment for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry.value} onChange={(event) => update({ ...entry, value: event.target.value })} /></label>
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(entry.day, entry)}>{editing ? "Apply weekday adjustment" : "Add weekday adjustment"}</button>
      {pending && <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel weekday entry</button>}
    </div>
    {pending && <p className="mt-2">{editing ? "Apply" : "Add"} or cancel this weekday entry before saving the draft.</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
