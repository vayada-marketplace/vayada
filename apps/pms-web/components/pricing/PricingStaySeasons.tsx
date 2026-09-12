"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { StayRuleFields, stayRuleInput, stayRules, type RuleInput } from "./StayRuleFields";
type Offer = PricingConfiguration["offers"][number];

export function changeStaySeason(room: PricingConfiguration, offerId: string, from: string, through: string, input: RuleInput | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new Error("Edit the offer that owns these stay rules.");
  const exists = offer.restrictions.seasons.some((entry) => entry.from === from && entry.through === through);
  if (!input && !exists) throw new Error("There is no stay rule to clear for this range.");
  const seasons = input ? [...offer.restrictions.seasons, { from, through, rules: stayRules(input) }] : offer.restrictions.seasons.filter((entry) => entry.from !== from || entry.through !== through);
  const restrictions = { ...offer.restrictions, seasons };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new Error("Use valid MM-DD dates without overlapping stay-rule seasons. Minimum must be positive; maximum must be blank or at least the minimum.");
  return result;
}

export function PricingStaySeasons({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [range, setRange] = useState({ from: "", through: "" }), [error, setError] = useState("");
  if (offer.restrictions.kind !== "own") return null;
  const defaults = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setRange({ from: "", through: "" }); setError(""); onPending(false); };
  const apply = (from: string, through: string, input: RuleInput | null) => {
    if (disabled) return;
    try { onChange(changeStaySeason(room, offer.id, from, through, input)); if (input) cancel(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change seasonal stay rules."); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Seasonal stay rules · {label}</summary>
    <p className="mt-2 text-gray-600">Stay-rule seasons repeat every year and include both MM-DD dates. Ranges can cross New Year; February 29 applies only in leap years. Stay-rule seasons cannot overlap. They replace defaults, but date-specific stay rules take priority. Minimum applies on arrival; maximum and stop-sell apply to occupied nights; closures use actual arrival/departure dates. Price seasons are separate. Clearing resumes defaults except where date rules apply.</p>
    <ul className="my-3 space-y-2">{offer.restrictions.seasons.map(({ from, through, rules }) => <li key={from} className="flex flex-wrap items-center gap-3">
      <span>{from}–{through}: minimum {rules.minArrivalNights} nights; maximum {rules.maxStayNights ?? "unlimited"}; arrivals {rules.closedToArrival ? "closed" : "open"}; departures {rules.closedToDeparture ? "closed" : "open"}; sales {rules.stopSell ? "stopped" : "open"}.</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={`Clear stay rules from ${from} to ${through} for ${label}`} onClick={() => apply(from, through, null)}>Clear seasonal stay rules</button>
    </li>)}</ul>
    {!entry ? <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => { if (disabled) return; setEntry(stayRuleInput(defaults)); setError(""); onPending(true); }}>Add seasonal stay rules</button> : <>
      <p className="my-3">Starting values are copied from the offer’s defaults, including closure flags. Review every field: this complete row replaces defaults throughout the range. Date-specific stay rules still win.</p>
      <div className="flex flex-wrap gap-3">{([["from", "Start (MM-DD)"], ["through", "End (MM-DD)"]] as const).map(([key, name]) => <label key={key}>{name}<input aria-label={`Stay-rule ${name} for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" value={range[key]} disabled={disabled} onChange={(event) => { setRange({ ...range, [key]: event.target.value }); setError(""); }} /></label>)}</div>
      <StayRuleFields entry={entry} label={`season rule ${label}`} disabled={disabled} onChange={(next) => { setEntry(next); setError(""); }} />
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(range.from, range.through, entry)}>Apply seasonal stay rules</button>
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel seasonal stay rules</button></div>
      <p className="mt-2">Apply or cancel this entry before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
