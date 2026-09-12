"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { StayRuleFields, stayRuleInput, stayRules, type RuleInput } from "./StayRuleFields";
type Offer = PricingConfiguration["offers"][number];

export function changeStayDate(room: PricingConfiguration, offerId: string, date: string, input: RuleInput | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new Error("Edit the offer that owns these stay rules.");
  const exists = offer.restrictions.dates.some((entry) => entry.date === date);
  if (input && exists) throw new Error("Clear the existing date rule before adding a replacement.");
  if (!input && !exists) throw new Error("There is no stay rule to clear on this date.");
  const dates = input ? [...offer.restrictions.dates, { date, rules: stayRules(input) }] : offer.restrictions.dates.filter((entry) => entry.date !== date);
  const restrictions = { ...offer.restrictions, dates };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new Error("Use a valid YYYY-MM-DD date and a positive whole-number minimum. Maximum must be blank or at least the minimum.");
  return result;
}

export function PricingStayDates({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [date, setDate] = useState(""), [error, setError] = useState("");
  if (offer.restrictions.kind !== "own") return null;
  const defaults = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setDate(""); setError(""); onPending(false); };
  const apply = (day: string, input: RuleInput | null) => {
    if (disabled) return;
    try { onChange(changeStayDate(room, offer.id, day, input)); if (input) cancel(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change date stay rules."); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Date-specific stay rules · {label}</summary>
    <p className="mt-2 text-gray-600">A date rule replaces all seasonal and default stay rules for that date. Minimum applies to arrivals that day; maximum and stop-sell apply to occupied nights. Closures apply to actual arrival or departure dates. Date prices are separate. Clearing resumes seasonal or default stay rules.</p>
    <ul className="my-3 space-y-2">{offer.restrictions.dates.map(({ date: day, rules }) => <li key={day} className="flex flex-wrap items-center gap-3">
      <span>{day}: minimum {rules.minArrivalNights} nights; maximum {rules.maxStayNights ?? "unlimited"}; arrivals {rules.closedToArrival ? "closed" : "open"}; departures {rules.closedToDeparture ? "closed" : "open"}; sales {rules.stopSell ? "stopped" : "open"}.</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={`Clear stay rules on ${day} for ${label}`} onClick={() => apply(day, null)}>Clear date stay rules</button>
    </li>)}</ul>
    {!entry ? <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => { if (disabled) return; setEntry(stayRuleInput(defaults)); setError(""); onPending(true); }}>Add date stay rules</button> : <>
      <p className="my-3">Starting values are copied from the offer’s defaults, including closure flags. Review every field: this complete row replaces any seasonal rule on the chosen date.</p>
      <label>Date (YYYY-MM-DD)<input aria-label={`Stay-rule date for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" value={date} disabled={disabled} onChange={(event) => { setDate(event.target.value); setError(""); }} /></label>
      <StayRuleFields entry={entry} label={`date rule ${label}`} disabled={disabled} onChange={(next) => { setEntry(next); setError(""); }} />
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(date, entry)}>Apply date stay rules</button>
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel date stay rules</button></div>
      <p className="mt-2">Apply or cancel this entry before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
