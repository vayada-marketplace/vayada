"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { IncludedPricing, includedPrice, type IncludedInput } from "./IncludedPricing";
import { parseMinorInput } from "./pricingAmounts";

export type SetupRoom = { roomTypeId: string; name: string; capacity: PricingConfiguration["capacity"] };
type Values = Record<"mode" | "room" | "currency" | "base" | "adultAge" | "childPrice" | "countChildren" | "minimum" | "maximum" | "cancellation" | "freeDays" | "payment", string> & { occupancy: string[]; included: IncludedInput };
export function firstPricingInput(propertyId: string, room: SetupRoom, offerId: string, values: Values, existingRoom?: PricingConfiguration) {
  if (existingRoom && (existingRoom.propertyId !== propertyId || existingRoom.roomTypeId !== room.roomTypeId || existingRoom.currency !== values.currency)) throw new Error("Keep the existing room and pricing currency.");
  const scale = pricingCurrencyScale(values.currency);
  const integer = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  if (scale === null || (!existingRoom && !["yes", "no"].includes(values.countChildren)) || values.payment !== "full" || !["non_refundable", "flexible"].includes(values.cancellation)) throw new Error("Complete every required pricing and policy setting.");
  if (!["flat", "occupancy", "per_person", "included_guests"].includes(values.mode)) throw new Error("Choose how to price this room.");
  if (values.mode === "occupancy" && values.occupancy.length !== room.capacity.adults) throw new Error("Enter a price for every adult count.");
  const base = values.mode === "included_guests" ? includedPrice(values.included, values.base, room.capacity.adults, scale) : values.mode === "occupancy" ? { mode: "occupancy", amountsMinor: Array.from(values.occupancy, (amount) => parseMinorInput(amount, scale)) }
    : values.mode === "per_person" ? { mode: "per_person", unitMinor: parseMinorInput(values.base, scale) }
    : { mode: "flat", amountMinor: parseMinorInput(values.base, scale) };
  const adultFromAge = integer(values.adultAge), minArrivalNights = integer(values.minimum);
  const cancellation: PricingTermsInput["cancellation"] = values.cancellation === "non_refundable" ? { kind: "non_refundable" } : { kind: "flexible", terms: {
    type: "free_until_days_before_arrival", freeCancellationDeadlineDays: integer(values.freeDays), afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } };
  const terms: PricingTermsInput = { roomTypeId: room.roomTypeId, offerId, expectedRevision: null, cancellation, payment: { kind: "full" } };
  const configuration = parsePricingConfiguration({ version: "pricing.v2", propertyId, roomTypeId: room.roomTypeId, revision: existingRoom?.revision ?? 1, currency: values.currency, capacity: room.capacity,
    children: existingRoom?.children ?? { adultFromAge, bands: [{ fromAge: 0, throughAge: adultFromAge - 1, nightlyMinor: parseMinorInput(values.childPrice, scale, true), countsTowardCapacity: values.countChildren === "yes" }] },
    offers: [...(existingRoom?.offers ?? []), { id: offerId, termsRevision: offerId, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: { kind: "independent", calendar: { base, months: [], seasons: [], weekdays: [], dates: [] } },
      restrictions: { kind: "own", rules: { minArrivalNights, maxStayNights: values.maximum === "" ? null : integer(values.maximum), closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
  });
  if (!parseBookingPricingOfferTerms({ roomTypeId: terms.roomTypeId, offerId, revision: offerId, cancellation, payment: terms.payment })) throw new Error("Check the cancellation deadline (0–365 days).");
  if (!configuration) throw new Error("Check the ages, stay limits, capacity and prices.");
  return { configuration, terms };
}
export function FirstPricingSetup({ propertyId, rooms, disabled, onDirty, onCreate, fixedCurrency, existingRoom }: { propertyId: string; rooms: readonly SetupRoom[]; disabled: boolean; onDirty: () => void;
  onCreate: (input: ReturnType<typeof firstPricingInput>) => void; fixedCurrency?: string; existingRoom?: PricingConfiguration }) {
  const [values, setValues] = useState<Values>({ mode: "", occupancy: [], included: { adults: "", adjustments: [] }, room: existingRoom?.roomTypeId ?? "", currency: fixedCurrency ?? "", base: "", adultAge: "", childPrice: "", countChildren: "", minimum: "", maximum: "", cancellation: "", freeDays: "", payment: "" });
  const [error, setError] = useState("");
  const change = (key: Exclude<keyof Values, "occupancy" | "included">, value: string) => { setValues({ ...values, [key]: value, ...(["room", "mode"].includes(key) ? { base: "", occupancy: [], included: { adults: "", adjustments: [] } } : {}) }); setError(""); onDirty(); };
  const field = (key: Exclude<keyof Values, "occupancy" | "included">, label: string) => <label className="block text-sm">{label}<input aria-label={label} disabled={disabled || (key === "currency" && !!fixedCurrency)} value={values[key]} className="mt-1 block w-full rounded-lg border px-3 py-2" onChange={(event) => change(key, event.target.value)} /></label>;
  const select = (key: Exclude<keyof Values, "occupancy" | "included">, label: string, options: [string, string][]) => <label className="block text-sm">{label}<select aria-label={label} disabled={disabled} value={values[key]} className="mt-1 block w-full rounded-lg border px-3 py-2" onChange={(event) => change(key, event.target.value)}><option value="">Choose…</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  if (!rooms.length) return <p>No active room types with complete capacity settings are available. Complete room setup first.</p>;
  const room = rooms.find((candidate) => candidate.roomTypeId === values.room);
  return <form className="mt-4 space-y-4" onSubmit={(event) => {
    event.preventDefault(); if (disabled) return;
    try { if (!room) throw new Error("Choose a room type."); onCreate(firstPricingInput(propertyId, room, crypto.randomUUID(), { ...values, currency: fixedCurrency ?? values.currency }, existingRoom)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Check the pricing settings."); }
  }}>
    <h2 className="text-lg font-semibold">{existingRoom ? "Create an independent offer" : fixedCurrency ? "Add another room price" : "Create your first room price"}</h2>
    <p className="text-sm text-gray-600">Start with one room-only offer: the chosen prices apply every night, no calendar exceptions, and arrivals, departures and sales open. Only active rooms with complete capacity settings are listed. You can edit the pricing rules after setup.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      {existingRoom ? <p>Room: {room?.name}</p> : select("room", "Room type", rooms.map((r) => [r.roomTypeId, r.name]))}{field("currency", "Currency code (for example EUR)")}
      {select("mode", "How is the room priced?", [["flat", "One price per room"], ["occupancy", "Price for each adult count"], ["per_person", "Price per adult"], ["included_guests", "Base price with adult-count adjustments"]])}
      {(values.mode === "flat" || values.mode === "included_guests") && field("base", "Room price per night")}
      {values.mode === "per_person" && field("base", "Price per adult per night")}
      {values.mode === "occupancy" && room && Array.from({ length: room.capacity.adults }, (_, index) => <label key={index} className="block text-sm">
        Room price for {index + 1} {index ? "adults" : "adult"} per night<input aria-label={`Room price for ${index + 1} ${index ? "adults" : "adult"} per night`} inputMode="decimal" disabled={disabled}
          value={values.occupancy[index] ?? ""} className="mt-1 block w-full rounded-lg border px-3 py-2" onChange={(event) => {
            const occupancy = Array.from({ length: room.capacity.adults }, (_, i) => i === index ? event.target.value : values.occupancy[i] ?? "");
            setValues({ ...values, occupancy }); setError(""); onDirty();
          }} /></label>)}
      {values.mode === "included_guests" && room && <IncludedPricing value={values.included} capacity={room.capacity.adults} disabled={disabled} onChange={(included) => { setValues({ ...values, included }); setError(""); onDirty(); }} />}
      {!existingRoom && <>
      {field("adultAge", "Adult pricing starts at age (1–18)")}
      {field("childPrice", "Price per child per night (0 is allowed)")}{select("countChildren", "Children count toward room capacity", [["yes", "Yes"], ["no", "No"]])}
      </>}
      {field("minimum", "Minimum stay in nights")}{field("maximum", "Maximum stay in nights (blank means unlimited)")}
      {select("cancellation", "Cancellation policy", [["non_refundable", "Non-refundable"], ["flexible", "Free cancellation until a deadline"]])}
      {values.cancellation === "flexible" && field("freeDays", "Free cancellation until days before arrival (0–365)")}
      {select("payment", "Payment policy", [["full", "Full payment"]])}
    </div>
    <p className="text-sm text-gray-600">Guests at or above the adult-pricing age use adult prices. Younger guests use the separate child price, even when they count toward capacity. An occupancy price is the room total for that adult count; a per-adult price is multiplied by the adult count. Child charges are added separately.</p>
    {room && <p className="text-sm">Room capacity: {room.capacity.total} total, up to {room.capacity.adults} adults and {room.capacity.children} children. {existingRoom ? "The existing child age bands and charges apply to this offer and remain unchanged." : "One child band covers age 0 through the year before adult pricing starts."}</p>}
    {values.cancellation === "flexible" && <p className="text-sm">After the cancellation deadline and for no-shows, the penalty is the full booking amount.</p>}
    <p className="text-sm text-gray-600">Continue saves the offer’s policy and checks pricing readiness. The policy remains saved if a later check fails. You must still save a draft, review charges and approve pricing. Nothing is sent to channels.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <button disabled={disabled} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50">Continue to draft</button>
  </form>;
}
