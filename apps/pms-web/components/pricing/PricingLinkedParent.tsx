"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeLinkedParent(room: PricingConfiguration, offerId: string, parentId: string): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "linked") throw new PricingError("pricing.error.linkedOfferRequired");
  const price = { ...offer.price, parentId };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, price } : value) });
  if (!result) throw new PricingError("pricing.linkedParent.errorCircular");
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
  const { t } = useTranslation();
  if (offer.price.kind !== "linked") return null;
  const currentParent = offer.price.parentId, choices = linkedParentChoices(room, offer.id);
  const name = (id: string) => t("pricing.offerNumber", { number: room.offers.findIndex((value) => value.id === id) + 1 });
  const alternative = choices.some((value) => value.id !== currentParent);
  const cancel = () => { setParent(null); setAck(false); setError(""); onPending(false); };
  return <div className="sm:col-span-2 rounded-lg border p-3 text-sm">
    <p>{t("pricing.linkedParent.current", { label, parent: name(currentParent) })}</p>
    {parent === null ? alternative ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return; setParent(currentParent); setAck(false); setError(""); onPending(true);
    }}>{t("pricing.linkedParent.change")}</button> : <p className="mt-2 text-gray-600">{t("pricing.linkedParent.noAlternative")}</p> : <>
      <p className="mt-2">{t("pricing.linkedParent.explanation")}</p>
      <p className="mt-2">{t(offer.restrictions.kind === "inherit" ? "pricing.linkedParent.inheritedRules" : "pricing.linkedParent.ownRules")} {t("pricing.linkedParent.descendants")}</p>
      <label className="mt-3 block">{t("pricing.linkedParent.newParent")}<select aria-label={t("pricing.linkedParent.selectLabel", { label })} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={parent} onChange={(event) => { setParent(event.target.value); setAck(false); setError(""); }}>{choices.map((candidate) => <option key={candidate.id} value={candidate.id}>{name(candidate.id)}</option>)}</select></label>
      <p className="mt-2">{t("pricing.linkedParent.changeFromTo", { from: name(currentParent), to: name(parent) })}</p>
      <label className="mt-3 flex gap-2"><input type="checkbox" disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />{t("pricing.linkedParent.acknowledge", { label })}</label>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || !ack || parent === currentParent} onClick={() => {
        if (disabled || !ack || parent === currentParent) return;
        try { onChange(changeLinkedParent(room, offer.id, parent)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.linkedParent.changeFailed")); }
      }}>{t("pricing.linkedParent.apply")}</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.linkedParent.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelBeforeOtherRules")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
