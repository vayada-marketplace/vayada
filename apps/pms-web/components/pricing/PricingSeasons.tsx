"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { baseAmounts, decimalAmount } from "./pricingAmounts";
import { recurringTemplate, recurringPrice, recurringAdjustments } from "./recurringPricingInputs";

import { IncludedPricing, includedInput, includedPrice, type IncludedInput } from "./IncludedPricing";

type Offer = PricingConfiguration["offers"][number];
type SeasonInput = { name: string; tier: string; from: string; through: string };
export function changeSeasonPrice(room: PricingConfiguration, offerId: string, season: SeasonInput, values: string[] | null, original: SeasonInput | null = null, included: IncludedInput | null = null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent") throw new Error("Seasonal prices belong to an independent offer.");
  const calendar = offer.price.calendar;
  let seasons = calendar.seasons;
  const target = original ?? season;
  const index = seasons.findIndex((entry) => entry.from === target.from && entry.through === target.through && entry.name === target.name && entry.tier === target.tier);
  if (original) {
    if (!season.name.trim()) throw new Error("Enter a season name.");
    if (index < 0 || !values) throw new Error("Choose an existing season price to edit.");
    if (included && (seasons[index].price.mode !== "included_guests" || values.length !== 1)) throw new Error("Choose an existing included-adult season price.");
    const price = included ? includedPrice(included, values[0], room.capacity.adults, pricingCurrencyScale(room.currency)!) : recurringPrice(offer, values, room.currency, seasons[index].price);
    seasons = seasons.map((entry, i) => i === index ? { ...entry, ...season, price } : entry);
  } else if (values) {
    if (included) throw new Error("Choose an existing included-adult season price.");
    if (!season.name.trim()) throw new Error("Enter a season name.");
    seasons = [...seasons, { ...season, price: recurringPrice(offer, values, room.currency) }];
  } else {
    if (index < 0) throw new Error("This season is unavailable. Reload pricing.");
    seasons = seasons.filter((_, i) => i !== index);
  }
  const price = { ...offer.price, calendar: { ...calendar, seasons } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new Error("Use valid MM-DD dates, keep seasons from overlapping, and check all adult prices.");
  return result;
}

export function PricingSeasons({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [included, setIncluded] = useState<IncludedInput | null>(null);
  const [entry, setEntry] = useState<SeasonInput>({ name: "", tier: "", from: "", through: "" }), [values, setValues] = useState<string[]>([]), [error, setError] = useState(""), [editing, setEditing] = useState<SeasonInput | null>(null);
  if (offer.price.kind !== "independent") return null;
  const template = editing ? offer.price.calendar.seasons.find((season) => season.from === editing.from && season.through === editing.through && season.name === editing.name && season.tier === editing.tier)?.price : recurringTemplate(offer), scale = pricingCurrencyScale(room.currency)!;
  const pending = !!editing || Object.values(entry).some(Boolean) || values.some(Boolean);
  const reset = () => { setEntry({ name: "", tier: "", from: "", through: "" }); setValues([]); setIncluded(null); setEditing(null); setError(""); onPending(false); };
  const apply = (season: SeasonInput, amounts: string[] | null) => {
    if (disabled || (!amounts && pending)) return;
    try { onChange(changeSeasonPrice(room, offer.id, season, amounts, editing, amounts ? included : null)); if (amounts) reset(); else setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change the season."); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Seasonal prices · {label}</summary>
    <p className="mt-2 text-gray-600">Seasons repeat every year and include both dates. Use MM-DD, for example 12-15 to 01-10 for a season crossing New Year. February 29 applies only in leap years. Seasons cannot overlap. Date prices take priority; seasons replace monthly or base prices, then weekday adjustments apply. Child and meal charges are separate. Clearing restores remaining rules; missing fallback prices can make nights unavailable.</p>
    <ul className="my-3 space-y-2">{offer.price.calendar.seasons.map((season) => <li key={season.from} className="flex flex-wrap items-center gap-3">
      <span>{season.name}{season.tier && ` (${season.tier})`} · {season.from}–{season.through}: {baseAmounts(season.price).map(([name, minor]) => `${name} ${decimalAmount(minor, scale)} ${room.currency}`).join("; ")}.{recurringAdjustments(season.price, room.currency, scale)}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Edit season ${season.from} to ${season.through} for ${label}`} onClick={() => {
        if (disabled || pending) return;
        setIncluded(season.price.mode === "included_guests" ? includedInput(season.price, scale) : null);
        const selected = { name: season.name, tier: season.tier, from: season.from, through: season.through }; setEditing(selected); setEntry(selected); setValues(baseAmounts(season.price).map(([, minor]) => decimalAmount(minor, scale))); setError(""); onPending(true);
      }}>Edit seasonal price</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={`Clear season ${season.from} to ${season.through} for ${label}`} onClick={() => apply(season, null)}>Clear seasonal price</button>
    </li>)}</ul>
    {!template ? <p>Set up recurring pricing before adding seasonal prices. This offer has no recurring price template.</p> : <>
      <p className="mb-3">{editing ? "Edit this season’s name, label, dates, prices and included-adult settings. Moving dates changes which nights use these prices; old dates fall back to remaining rules and may become unavailable. Separate stay restrictions remain unchanged." : "Seasonal prices use this offer’s current pricing mode."}{recurringAdjustments(template, room.currency, scale)}{!editing && template.mode === "included_guests" && " These included-adult settings stay the same when adding a season."}</p>
      <div className="flex flex-wrap items-end gap-3">
        {([["name", "Season name"], ["tier", "Tier label (optional)"], ["from", "Start (MM-DD)"], ["through", "End (MM-DD)"]] as const).map(([key, name]) => <label key={key}>{name}<input aria-label={`${name} for ${label}`} className="mt-1 block w-40 rounded border px-3 py-2" disabled={disabled} value={entry[key]} onChange={(event) => {
          if (disabled) return;
          const next = { ...entry, [key]: event.target.value }; setEntry(next); setError(""); onPending(!!editing || Object.values(next).some(Boolean) || values.some(Boolean));
        }} /></label>)}
        {baseAmounts(included && template.mode === "included_guests" ? { ...template, baseGuests: Number(included.adults) || template.baseGuests } : template).map(([name], index) => <label key={index}>{name} ({room.currency})<input aria-label={`Seasonal ${name} for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values[index] ?? ""} onChange={(event) => {
          const next = Array.from({ length: baseAmounts(template).length }, (_, i) => i === index ? event.target.value : values[i] ?? ""); setValues(next); setError(""); onPending(!!editing || Object.values(entry).some(Boolean) || next.some(Boolean));
        }} /></label>)}
        {included && <div className="w-full"><p>The base amount above belongs to this seasonal price. Changing the included count clears its adjustments.</p><IncludedPricing value={included} label={`${label} seasonal price`} capacity={room.capacity.adults} disabled={disabled} onChange={(next) => { if (disabled) return; setIncluded(next); setError(""); }} /></div>}
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(entry, values)}>{editing ? "Apply seasonal price" : "Add seasonal price"}</button>
      </div>
    </>}
    {pending && <><button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>Cancel season entry</button><p className="mt-2">{editing ? "Apply" : "Add"} or cancel this season entry before saving the draft.</p></>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
