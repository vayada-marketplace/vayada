"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { parseAdjustmentInput } from "./pricingAmounts";

type Values = { parent: string; kind: string; value: string; cancellation: string; deadline: string; payment: string };
export function linkedOfferInput(room: PricingConfiguration, offerId: string, values: Values) {
  if (!room.offers.some((offer) => offer.id === values.parent) || values.payment !== "full" || !["non_refundable", "flexible"].includes(values.cancellation)) throw new Error("Choose a parent, cancellation policy and payment policy.");
  const cancellation: PricingTermsInput["cancellation"] = values.cancellation === "non_refundable" ? { kind: "non_refundable" } : { kind: "flexible", terms: {
    type: "free_until_days_before_arrival", freeCancellationDeadlineDays: /^\d+$/.test(values.deadline) ? Number(values.deadline) : NaN, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } };
  const terms: PricingTermsInput = { roomTypeId: room.roomTypeId, offerId, expectedRevision: null, cancellation, payment: { kind: "full" } };
  if (!parseBookingPricingOfferTerms({ roomTypeId: room.roomTypeId, offerId, revision: offerId, cancellation, payment: terms.payment })) throw new Error("Check the cancellation deadline (0–365 days).");
  const configuration = parsePricingConfiguration({ ...room, offers: [...room.offers, { id: offerId, termsRevision: offerId,
    meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } }, restrictions: { kind: "inherit" },
    price: { kind: "linked", parentId: values.parent, adjustment: parseAdjustmentInput(values, room.currency), dateOverrides: [] } }] });
  if (!configuration) throw new Error("Check the new offer identity and adjustment range.");
  return { configuration, terms };
}

export function NewLinkedOffer({ room, disabled, onCreate }: { room: PricingConfiguration; disabled: boolean; onCreate: (input: ReturnType<typeof linkedOfferInput>) => void }) {
  const [values, setValues] = useState<Values>({ parent: "", kind: "", value: "", cancellation: "", deadline: "", payment: "" }), [error, setError] = useState("");
  const change = (key: keyof Values, value: string) => { setValues({ ...values, [key]: value, ...(key === "kind" ? { value: "" } : {}) }); setError(""); };
  const select = (key: keyof Values, label: string, options: [string, string][]) => <label>{label}<select aria-label={label} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={values[key]} onChange={(event) => change(key, event.target.value)}><option value="">Choose…</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <form className="space-y-3 text-sm" onSubmit={(event) => {
    event.preventDefault(); if (disabled) return;
    try { onCreate(linkedOfferInput(room, crypto.randomUUID(), values)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the new offer settings."); }
  }}>
    <h3 className="font-semibold">Create a linked offer</h3>
    <p>Start with a room-only offer, no final date prices and stay rules inherited from the parent. The adjustment applies to the parent’s adult room price; child supplements are separate and the parent’s meal charge is not copied. You can change meals, dates and stay rules after setup.</p>
    <div className="flex flex-wrap gap-3">
      {select("parent", "New offer parent", room.offers.map((offer, index) => [offer.id, `Offer ${index + 1}`]))}
      {select("kind", "New offer adjustment type", [["fixed", `Amount in ${room.currency}`], ["percentage", "Percentage"]])}
      <label>Adjustment {values.kind === "percentage" ? "(%)" : `(${room.currency})`}<input aria-label="New offer adjustment" className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values.value} onChange={(event) => change("value", event.target.value)} /></label>
      {select("cancellation", "New offer cancellation policy", [["non_refundable", "Non-refundable"], ["flexible", "Free cancellation until a deadline"]])}
      {values.cancellation === "flexible" && <label>Free cancellation until days before arrival (0–365)<input aria-label="New offer cancellation deadline" className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values.deadline} onChange={(event) => change("deadline", event.target.value)} /></label>}
      {select("payment", "New offer payment policy", [["full", "Full payment"]])}
    </div>
    <p>Use a minus sign for a reduction; 0 keeps the parent’s room price. A result of zero or less makes that night unavailable. Flexible cancellation charges the full booking amount after the deadline and for no-shows.</p>
    <p>Continue saves this offer’s policy and checks pricing readiness. Keep the page open to retry if needed; accepted policies remain saved. You must then save the draft, review charges and approve rates. Nothing is sent to channels.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <button disabled={disabled} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50">Continue with linked offer</button>
  </form>;
}
