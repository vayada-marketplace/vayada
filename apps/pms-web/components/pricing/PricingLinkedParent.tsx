"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";
import { PricingSection } from "./PricingSection";
import * as ui from "./pricingStyles";

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

/** `names`: the options' names (step 4); without them options show as "Offer N". */
export function PricingLinkedParent({ room, offer, names, label, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; names?: Readonly<Record<string, string>>; label: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [parent, setParent] = useState<string | null>(null), [ack, setAck] = useState(false), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.price.kind !== "linked") return null;
  const currentParent = offer.price.parentId, choices = linkedParentChoices(room, offer.id);
  const name = (id: string) => names?.[id] ?? t("pricing.offerNumber", { number: room.offers.findIndex((value) => value.id === id) + 1 });
  const alternative = choices.some((value) => value.id !== currentParent);
  const cancel = () => { setParent(null); setAck(false); setError(""); onPending(false); };
  return <PricingSection title={t("pricing.linkedParent.section")} label={t("pricing.linkedParent.current", { label, parent: name(currentParent) })} value={name(currentParent)} keepOpen={parent !== null}>
    {parent === null ? alternative ? <button type="button" className={ui.secondaryButton} disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return; setParent(currentParent); setAck(false); setError(""); onPending(true);
    }}>{t("pricing.linkedParent.change")}</button> : <p className={ui.help}>{t("pricing.linkedParent.noAlternative")}</p> : <>
      <p className="mt-2">{t("pricing.linkedParent.explanation")}</p>
      <p className="mt-2">{t(offer.restrictions.kind === "inherit" ? "pricing.linkedParent.inheritedRules" : "pricing.linkedParent.ownRules")} {t("pricing.linkedParent.descendants")}</p>
      <label className={ui.fieldLabel}>{t("pricing.linkedParent.newParent")}<select aria-label={t("pricing.linkedParent.selectLabel", { label })} className={`mt-1.5 block ${ui.field}`} disabled={disabled} value={parent} onChange={(event) => { setParent(event.target.value); setAck(false); setError(""); }}>{choices.map((candidate) => <option key={candidate.id} value={candidate.id}>{name(candidate.id)}</option>)}</select></label>
      <p className="mt-2">{t("pricing.linkedParent.changeFromTo", { from: name(currentParent), to: name(parent) })}</p>
      <label className="flex items-center gap-2"><input type="checkbox" aria-label={t("pricing.linkedParent.acknowledge", { label })} disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />{t("pricing.linkedParent.acknowledgeShort")}</label>
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondaryButton} disabled={disabled || !ack || parent === currentParent} onClick={() => {
        if (disabled || !ack || parent === currentParent) return;
        try { onChange(changeLinkedParent(room, offer.id, parent)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.linkedParent.changeFailed")); }
      }}>{t("pricing.linkedParent.apply")}</button><button type="button" className={ui.secondaryButton} disabled={disabled} onClick={cancel}>{t("pricing.linkedParent.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelBeforeOtherRules")}</p>
    </>}
    {error && <p role="alert" className={ui.errorText}>{error}</p>}
  </PricingSection>;
}
