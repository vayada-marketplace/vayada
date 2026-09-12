"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { decimalAmount, parseAdjustmentInput } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
type Entry = { kind: string; value: string };
export function changeLinkedAdjustment(room: PricingConfiguration, offerId: string, input: Entry): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "linked") throw new Error("Choose an existing linked offer.");
  const price = { ...offer.price, adjustment: parseAdjustmentInput(input, room.currency) };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, price } : value) });
  if (!result) throw new Error("This adjustment is outside the supported range or the pricing configuration is invalid.");
  return result;
}

export function PricingLinkedAdjustment({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<Entry | null>(null), [error, setError] = useState("");
  if (offer.price.kind !== "linked") return null;
  const { adjustment, parentId } = offer.price;
  const minor = adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
  const value = `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? pricingCurrencyScale(room.currency)! : 2)}`;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">Linked price adjustment · {label}</summary>
    <p className="mt-2">Parent: Offer {room.offers.findIndex((candidate) => candidate.id === parentId) + 1}. Adjustment: {value}{adjustment.kind === "percentage" ? "%" : ` ${room.currency}`}.</p>
    <p className="mt-2 text-gray-600">Adjust the parent’s adult room price. Child and this offer’s meal charges are added separately; the parent’s meal charge is not copied. Final date prices bypass this adjustment. Use a minus sign for a reduction; 0 keeps the parent price. A result of zero or less makes that night unavailable.</p>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
      if (disabled) return; setEntry({ kind: adjustment.kind, value }); setError(""); onPending(true);
    }}>Edit linked adjustment</button> : <>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label>Adjustment type<select aria-label={`Linked adjustment type for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={entry.kind} onChange={(event) => { setEntry({ kind: event.target.value, value: "" }); setError(""); }}>
          <option value="fixed">Amount in {room.currency}</option><option value="percentage">Percentage</option>
        </select></label>
        <label>Adjustment {entry.kind === "percentage" ? "(%)" : `(${room.currency})`}<input aria-label={`Linked adjustment for ${label}`} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry.value} onChange={(event) => { setEntry({ ...entry, value: event.target.value }); setError(""); }} /></label>
      </div>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeLinkedAdjustment(room, offer.id, entry)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change linked adjustment."); }
      }}>Apply linked adjustment</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel linked adjustment</button></div>
      <p className="mt-2">Apply or cancel this edit before saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
