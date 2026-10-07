"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
function parentOwner(room: PricingConfiguration, offer: Offer): Offer {
  if (offer.price.kind !== "linked") throw new PricingError("pricing.stayOwnership.errorIndependent");
  let owner = room.offers.find((value) => value.id === (offer.price.kind === "linked" ? offer.price.parentId : ""))!;
  while (owner.restrictions.kind === "inherit") {
    const parentId = owner.price.kind === "linked" ? owner.price.parentId : "";
    owner = room.offers.find((value) => value.id === parentId)!;
  }
  return owner;
}
export function changeStayOwnership(room: PricingConfiguration, offerId: string): PricingConfiguration {
  const valid = parsePricingConfiguration(room);
  if (!valid) throw new PricingError("pricing.stayOwnership.errorInvalid");
  const offer = valid.offers.find((value) => value.id === offerId);
  if (!offer) throw new PricingError("pricing.error.offerMissing");
  const owner = parentOwner(valid, offer);
  const restrictions: Offer["restrictions"] = offer.restrictions.kind === "own" ? { kind: "inherit" } : owner.restrictions;
  const result = parsePricingConfiguration({ ...valid, offers: valid.offers.map((value) => value.id === offerId ? { ...value, restrictions } : value) });
  if (!result) throw new PricingError("pricing.stayOwnership.changeFailed");
  return result;
}

export function PricingStayOwnership({ room, offer, label, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [editing, setEditing] = useState(false), [ack, setAck] = useState(false), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.price.kind !== "linked") return null;
  const valid = parsePricingConfiguration(room);
  if (!valid) return <p role="alert">{t("pricing.stayOwnership.reloadFirst")}</p>;
  const owner = parentOwner(valid, offer), own = offer.restrictions.kind === "own";
  const policy = own ? offer.restrictions : owner.restrictions;
  const cancel = () => { setEditing(false); setAck(false); setError(""); onPending(false); };
  return <div className="sm:col-span-2 rounded-lg border p-3 text-sm">
    <p>{t("pricing.stayOwnership.current", { label, rules: t(own ? "pricing.stayOwnership.ownRules" : "pricing.stayOwnership.inheritedRules"), number: room.offers.findIndex((value) => value.id === owner.id) + 1 })}</p>
    {!editing ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return; setEditing(true); setAck(false); onPending(true);
    }}>{t(own ? "pricing.stayOwnership.useParent" : "pricing.stayOwnership.useOwn")}</button> : <>
      <p className="mt-2">{t(own ? "pricing.stayOwnership.removeOwn" : "pricing.stayOwnership.copyParent")}</p>
      {policy.kind === "own" && <p className="mt-2">{t(own ? "pricing.stayOwnership.removing" : "pricing.stayOwnership.copying", { dates: policy.dates.length, seasons: policy.seasons.length })}</p>}
      <label className="mt-3 flex gap-2"><input type="checkbox" disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />{t("pricing.stayOwnership.acknowledge", { label })}</label>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || !ack} onClick={() => {
        if (disabled || !ack) return;
        try { onChange(changeStayOwnership(room, offer.id)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.stayOwnership.changeFailed")); }
      }}>{t("pricing.stayOwnership.apply")}</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.stayOwnership.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelBeforeOtherRules")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
