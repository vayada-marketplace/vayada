"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";

type Offer = PricingConfiguration["offers"][number];
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";
import { StayRuleFields, stayRuleInput, stayRules, type RuleInput } from "./StayRuleFields";
import { PricingSection } from "./PricingSection";
import * as ui from "./pricingStyles";
export function changeStayRules(room: PricingConfiguration, offerId: string, input: RuleInput): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new PricingError("pricing.stayRules.errorInherited");
  const rules = stayRules(input);
  const restrictions = { ...offer.restrictions, rules };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new PricingError("pricing.stayRules.errorInvalid");
  return result;
}

export function PricingStayRules({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.restrictions.kind === "inherit") return <p className={ui.note}>{t("pricing.stayRules.inherited")}</p>;
  const rules = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <PricingSection title={t("pricing.stayRules.section")} label={t("pricing.stayRules.title", { label })} keepOpen={!!entry}>
    <p className="mt-2">{t("pricing.stayRules.summary", { min: rules.minArrivalNights, max: rules.maxStayNights ?? t("pricing.stay.unlimited"), arrivals: t(rules.closedToArrival ? "pricing.stay.closed" : "pricing.stay.open"), departures: t(rules.closedToDeparture ? "pricing.stay.closed" : "pricing.stay.open"), sales: t(rules.stopSell ? "pricing.stay.stopped" : "pricing.stay.open") })}</p>
    <p className={ui.help}>{t("pricing.stayRules.description")}</p>
    {!entry ? <button type="button" className={ui.secondaryButton} disabled={disabled} onClick={() => {
      if (disabled) return; setEntry(stayRuleInput(rules)); setError(""); onPending(true);
    }}>{t("pricing.stayRules.edit")}</button> : <>
      <StayRuleFields entry={entry} label={label} disabled={disabled} onChange={(next) => { setEntry(next); setError(""); }} />
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondaryButton} disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeStayRules(room, offer.id, entry)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.stayRules.changeFailed")); }
      }}>{t("pricing.stayRules.apply")}</button><button type="button" className={ui.secondaryButton} disabled={disabled} onClick={cancel}>{t("pricing.stayRules.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelEdit")}</p>
    </>}
    {error && <p role="alert" className={ui.errorText}>{error}</p>}
  </PricingSection>;
}
