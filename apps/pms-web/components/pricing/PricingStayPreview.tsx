"use client";

import { useEffect, useState } from "react";
import { calculateReplacementRoomStay, pricingCurrencyScale, type RoomStayPricingResult } from "@vayada/domain-pms/replacement-pricing";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";
import { decimalAmount, editedSnapshot } from "./pricingAmounts";

type Props = { snapshot: PricingSnapshot; inputs: Record<string, string>; disabled: boolean; saved: boolean; roomNames: Record<string, string> };
const reasons: Record<Extract<RoomStayPricingResult, { kind: "unavailable" }>["reason"], string> = {
  invalid_configuration: "Correct the pricing settings before previewing this stay.",
  invalid_request: "Choose valid check-in and check-out dates, with checkout after check-in.",
  invalid_guests: "This guest combination does not fit the room's adult, child or capacity rules.",
  stale: "The pricing selection changed. Reload pricing and try again.",
  missing_terms: "The selected offer's terms are missing. Reload pricing.",
  missing_price: "This offer has no valid price for one or more selected nights.",
  restriction: "The stay does not meet this offer's stay-length, arrival, departure or stop-sell rules.",
  overflow: "The calculated price is too large. Check the configured amounts.",
};

export function PricingStayPreview({ snapshot, inputs, disabled, saved, roomNames }: Props) {
  const [choice, setChoice] = useState("0:0"), [checkIn, setCheckIn] = useState(""), [checkOut, setCheckOut] = useState("");
  const [adults, setAdults] = useState("2"), [ages, setAges] = useState("");
  const [answer, setAnswer] = useState<{ key: string; result?: RoomStayPricingResult; error?: string } | null>(null);
  const key = JSON.stringify([snapshot, inputs, disabled, saved, choice, checkIn, checkOut, adults, ages]);
  // Hide stale totals during render, then forget them so reverting an edit cannot revive a prior result.
  useEffect(() => { setAnswer(null); }, [key]);
  const shown = !disabled && answer?.key === key ? answer : null;
  const result = shown?.result;
  function preview() {
    if (disabled) return;
    try {
      if (!/^\d+$/.test(adults) || (ages.trim() && !/^\d+(\s*,\s*\d+)*$/.test(ages.trim()))) throw new Error("Enter a whole adult count and child ages separated by commas, for example 4, 8.");
      if ((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000 > 366) throw new Error("Preview up to 366 nights at a time.");
      const [ri, oi] = choice.split(":").map(Number), config = editedSnapshot(snapshot, inputs).rooms[ri], offer = config?.offers[oi];
      if (!config || !offer) throw new Error("Choose an available room and offer.");
      const result = calculateReplacementRoomStay(config, { propertyId: config.propertyId, roomTypeId: config.roomTypeId, offerId: offer.id,
        expectedRevision: config.revision, expectedTermsRevisions: Object.fromEntries(config.offers.map((item) => [item.id, item.termsRevision])),
        checkIn, checkOut, guests: { adults: Number(adults), childAgesAtCheckIn: ages.trim() ? ages.split(",").map((age) => Number(age.trim())) : [] } });
      setAnswer({ key, result });
    } catch (error) { setAnswer({ key, error: error instanceof Error ? error.message : "These prices could not be calculated." }); }
  }
  const money = (minor: string) => `${decimalAmount(minor, pricingCurrencyScale(snapshot.currency)!)} ${snapshot.currency}`;
  return <section aria-label="Stay price preview" className="rounded-xl border bg-white p-5">
    <h2 className="font-semibold">Preview a stay</h2>
    <p className="mt-2 text-sm text-gray-600">{saved ? "Using the exact saved prices under review." : "Using the prices currently shown, including unsaved edits."} This estimates room and meal charges only. It does not check inventory, booking cutoffs, promotions, add-ons, extra taxes or fees, or payment readiness. It is not a booking quote.</p>
    <fieldset disabled={disabled} className="mt-4 flex flex-wrap gap-4 disabled:opacity-50">
      <label className="text-sm">Room and offer<select aria-label="Preview room and offer" value={choice} onChange={(e) => setChoice(e.target.value)} className="mt-1 block rounded border p-2">
        {snapshot.rooms.flatMap((room, ri) => room.offers.map((offer, oi) => <option key={`${ri}:${oi}`} value={`${ri}:${oi}`}>{roomNames[room.roomTypeId] ?? `Room ${ri + 1}`} · Offer {oi + 1} · {offer.meal.kind.replaceAll("_", " ")}</option>))}
      </select></label>
      <label className="text-sm">Check-in<input aria-label="Preview check-in" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="mt-1 block rounded border p-2" /></label>
      <label className="text-sm">Check-out<input aria-label="Preview check-out" type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="mt-1 block rounded border p-2" /></label>
      <label className="text-sm">Adults<input aria-label="Preview adults" inputMode="numeric" maxLength={3} value={adults} onChange={(e) => setAdults(e.target.value)} className="mt-1 block w-20 rounded border p-2" /></label>
      <label className="text-sm">Child ages at check-in<input aria-label="Preview child ages at check-in" placeholder="For example 4, 8" maxLength={128} value={ages} onChange={(e) => setAges(e.target.value)} className="mt-1 block w-44 rounded border p-2" /></label>
      <button type="button" disabled={disabled} onClick={preview} className="self-end rounded-lg border border-emerald-700 px-4 py-2 text-emerald-800">Calculate room and meals</button>
    </fieldset>
    {disabled && <p className="mt-3 text-sm">Finish or cancel pending edits and resolve any pricing action before previewing.</p>}
    {(shown?.error || result?.kind === "unavailable") && <p role="alert" className="mt-3 text-sm text-red-800">{shown?.error ?? (result?.kind === "unavailable" ? reasons[result.reason] : "")}</p>}
    {result?.kind === "priced" && <div role="status" className="mt-4 space-y-2">
      <p className="font-semibold">Room and meal estimate: {money(result.totalMinor)}</p>
      <p className="text-sm">Room charges: {money(result.roomMinor)} · Meal charges: {money(result.mealMinor)} · {result.nights.length} {result.nights.length === 1 ? "night" : "nights"}</p>
      <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-sm [&_td]:pr-4 [&_td]:py-1 [&_th]:pr-4"><caption className="sr-only">Nightly room and meal breakdown</caption><thead><tr><th scope="col">Night</th><th scope="col">Room</th><th scope="col">Meals</th><th scope="col">Total</th><th scope="col">Price rules used</th></tr></thead>
        <tbody>{result.nights.map((night) => <tr key={night.date}><td>{night.date}</td><td>{money(night.roomMinor)}</td><td>{money(night.mealMinor)}</td><td>{money(night.totalMinor)}</td><td>{night.sources.map((source) => `Offer ${snapshot.rooms.find((room) => room.roomTypeId === result.roomTypeId)!.offers.findIndex((offer) => offer.id === source.offerId) + 1}: ${source.kind}`).join(", ")}</td></tr>)}</tbody>
      </table></div>
    </div>}
  </section>;
}
