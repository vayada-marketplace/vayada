"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";

type Offer = PricingConfiguration["offers"][number];
function parentOwner(room: PricingConfiguration, offer: Offer): Offer {
  if (offer.price.kind !== "linked") throw new Error("Independent offers must own their stay rules.");
  let owner = room.offers.find((value) => value.id === (offer.price.kind === "linked" ? offer.price.parentId : ""))!;
  while (owner.restrictions.kind === "inherit") {
    const parentId = owner.price.kind === "linked" ? owner.price.parentId : "";
    owner = room.offers.find((value) => value.id === parentId)!;
  }
  return owner;
}
export function changeStayOwnership(room: PricingConfiguration, offerId: string): PricingConfiguration {
  const valid = parsePricingConfiguration(room);
  if (!valid) throw new Error("The pricing configuration is invalid. Reload pricing.");
  const offer = valid.offers.find((value) => value.id === offerId);
  if (!offer) throw new Error("The offer is missing. Reload pricing.");
  const owner = parentOwner(valid, offer);
  const restrictions: Offer["restrictions"] = offer.restrictions.kind === "own" ? { kind: "inherit" } : owner.restrictions;
  const result = parsePricingConfiguration({ ...valid, offers: valid.offers.map((value) => value.id === offerId ? { ...value, restrictions } : value) });
  if (!result) throw new Error("Could not change stay-rule ownership.");
  return result;
}

export function PricingStayOwnership({ room, offer, label, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [editing, setEditing] = useState(false), [ack, setAck] = useState(false), [error, setError] = useState("");
  if (offer.price.kind !== "linked") return null;
  const valid = parsePricingConfiguration(room);
  if (!valid) return <p role="alert">Reload pricing before changing stay-rule ownership.</p>;
  const owner = parentOwner(valid, offer), own = offer.restrictions.kind === "own";
  const policy = own ? offer.restrictions : owner.restrictions;
  const cancel = () => { setEditing(false); setAck(false); setError(""); onPending(false); };
  return <div className="sm:col-span-2 rounded-lg border p-3 text-sm">
    <p>Stay-rule ownership · {label}: {own ? "own rules" : "inherited rules"}. Parent rules come from Offer {room.offers.findIndex((value) => value.id === owner.id) + 1}.</p>
    {!editing ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return; setEditing(true); setAck(false); onPending(true);
    }}>{own ? "Use parent stay rules" : "Use own stay rules"}</button> : <>
      <p className="mt-2">{own ? "Your own defaults and all date and seasonal stay-rule exceptions will be removed. This offer will follow the parent’s rules, including future changes." : "Copy the parent’s complete stay rules as a snapshot. Later parent changes will no longer update this offer’s stay rules."}</p>
      {policy.kind === "own" && <p className="mt-2">{own ? "Removing" : "Copying"}: defaults, {policy.dates.length} date rules and {policy.seasons.length} seasonal rules.</p>}
      <label className="mt-3 flex gap-2"><input type="checkbox" disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />I understand this stay-rule change for {label}.</label>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || !ack} onClick={() => {
        if (disabled || !ack) return;
        try { onChange(changeStayOwnership(room, offer.id)); cancel(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change stay-rule ownership."); }
      }}>Apply stay-rule ownership</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>Cancel ownership change</button></div>
      <p className="mt-2">Apply or cancel before editing other rules or saving the draft.</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
