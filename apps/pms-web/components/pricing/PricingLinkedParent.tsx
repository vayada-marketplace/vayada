"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";

type Offer = PricingConfiguration["offers"][number];
export function changeLinkedParent(room: PricingConfiguration, offerId: string, parentId: string): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "linked") throw new Error("Choose an existing linked offer.");
  const price = { ...offer.price, parentId };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, price } : value) });
  if (!result) throw new Error("Choose a parent in this room that does not create a circular link.");
  return result;
}
export function linkedParentChoices(room: PricingConfiguration, offerId: string) {
  return room.offers.filter((candidate) => {
    try { changeLinkedParent(room, offerId, candidate.id); return true; } catch { return false; }
  });
}

export function PricingLinkedParent({ room, offer, label, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [parent, setParent] = useState<string | null>(null), [ack, setAck] = useState(false), [error, setError] = useState("");
  if (offer.price.kind !== "linked") return null;
  const currentParent = offer.price.parentId, choices = linkedParentChoices(room, offer.id);
  const name = (id: string) => `Offer ${room.offers.findIndex((value) => value.id === id) + 1}`;
  const alternative = choices.some((value) => value.id !== currentParent);
  const cancel = () => { setParent(null); setAck(false); setError(""); onPending(false); };
  return <div className="sm:col-span-2 rounded-lg border p-3 text-sm">
    <p>Parent rate · {label}: {name(currentParent)}.</p>
    {parent === null ? alternative ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return; setParent(currentParent); setAck(false); setError(""); onPending(true);
    }}>Change parent rate</button> : <p className="mt-2 text-gray-600">No other valid parent rate is available in this room.</p> : <>
      <p className="mt-2">The selected parent supplies the room price before this offer’s adjustment. Final date overrides still take priority. This offer keeps its own meal charges.</p>
      <p className="mt-2">{offer.restrictions.kind === "inherit" ? "Inherited stay rules will follow the new parent, including its future changes." : "This offer will keep its own default, date and seasonal stay rules."} Offers linked below this one may also follow changed prices and inherited stay rules.</p>
      <label className="mt-3 block">New parent rate<select aria-label={`Parent rate for ${label}`} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={parent} onChange={(event) => { setParent(event.target.value); setAck(false); setError(""); }}>{choices.map((candidate) => <option key={candidate.id} value={candidate.id}>{name(candidate.id)}</option>)}</select></label>
      <p className="mt-2">Change from {name(currentParent)} to {name(parent)}.</p>
      <label className="mt-3 flex gap-2"><input type="checkbox" disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />Use this parent rate for {label}.</label>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || !ack || parent === currentParent} onClick={() => {
        if (disabled || !ack || parent === currentParent) return;
        try { onChange(changeLinkedParent(room, offer.id, parent)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change parent rate."); }
      }}>Apply parent rate</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel parent rate</button></div>
      <p className="mt-2">Apply or cancel before editing other rules or saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
