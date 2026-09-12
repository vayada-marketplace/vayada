"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";

type Offer = PricingConfiguration["offers"][number];
type RuleInput = { minimum: string; maximum: string; closedToArrival: boolean; closedToDeparture: boolean; stopSell: boolean };
export function changeStayRules(room: PricingConfiguration, offerId: string, input: RuleInput): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new Error("This offer inherits its stay rules. Edit the owning offer.");
  const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  const rules = { minArrivalNights: integer(input.minimum), maxStayNights: input.maximum === "" ? null : integer(input.maximum), closedToArrival: input.closedToArrival, closedToDeparture: input.closedToDeparture, stopSell: input.stopSell };
  const restrictions = { ...offer.restrictions, rules };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new Error("Enter a positive whole-number minimum. Maximum must be blank or a whole number at least as large as the minimum.");
  return result;
}

export function PricingStayRules({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [error, setError] = useState("");
  if (offer.restrictions.kind === "inherit") return <p className="sm:col-span-2 text-sm">Stay rules · {label}: inherited from the parent offer. Edit the owning offer to change these rules.</p>;
  const rules = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Default stay rules · {label}</summary>
    <p className="mt-2">Minimum arrival stay: {rules.minArrivalNights} nights; maximum stay: {rules.maxStayNights ?? "unlimited"}. Arrivals {rules.closedToArrival ? "closed" : "open"}; departures {rules.closedToDeparture ? "closed" : "open"}; sales {rules.stopSell ? "stopped" : "open"}.</p>
    <p className="mt-2 text-gray-600">Date and seasonal stay-rule exceptions override these defaults. Minimum stay is checked on arrival; the tightest maximum across occupied nights applies. Arrival and departure closures use the actual arrival and departure dates. Stop-sell blocks stays occupying a closed night. Pricing exceptions do not replace stay rules.</p>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
      if (disabled) return; setEntry({ minimum: String(rules.minArrivalNights), maximum: rules.maxStayNights === null ? "" : String(rules.maxStayNights), closedToArrival: rules.closedToArrival, closedToDeparture: rules.closedToDeparture, stopSell: rules.stopSell }); setError(""); onPending(true);
    }}>Edit stay rules</button> : <>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {([["minimum", "Minimum nights"], ["maximum", "Maximum nights (blank means unlimited)"]] as const).map(([key, name]) => <label key={key}>{name}<input aria-label={`${name} for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" disabled={disabled} value={entry[key]} onChange={(event) => { setEntry({ ...entry, [key]: event.target.value }); setError(""); }} /></label>)}
        {([["closedToArrival", "Close arrivals"], ["closedToDeparture", "Close departures"], ["stopSell", "Stop sales"]] as const).map(([key, name]) => <label key={key} className="flex items-center gap-2 py-2"><input type="checkbox" aria-label={`${name} for ${label}`} disabled={disabled} checked={entry[key]} onChange={(event) => { setEntry({ ...entry, [key]: event.target.checked }); setError(""); }} />{name}</label>)}
      </div>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeStayRules(room, offer.id, entry)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change stay rules."); }
      }}>Apply stay rules</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel stay-rule edit</button></div>
      <p className="mt-2">Apply or cancel this edit before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
