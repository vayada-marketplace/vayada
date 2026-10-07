"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";
import { StayRuleFields, stayRuleInput, stayRules, type RuleInput } from "./StayRuleFields";
type Offer = PricingConfiguration["offers"][number];

export function changeStaySeason(room: PricingConfiguration, offerId: string, from: string, through: string, input: RuleInput | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  const exists = offer.restrictions.seasons.some((entry) => entry.from === from && entry.through === through);
  if (!input && !exists) throw new PricingError("pricing.staySeasons.errorNothingToClear");
  const seasons = input ? [...offer.restrictions.seasons, { from, through, rules: stayRules(input) }] : offer.restrictions.seasons.filter((entry) => entry.from !== from || entry.through !== through);
  const restrictions = { ...offer.restrictions, seasons };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new PricingError("pricing.staySeasons.errorInvalid");
  return result;
}

export function PricingStaySeasons({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [range, setRange] = useState({ from: "", through: "" }), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.restrictions.kind !== "own") return null;
  const defaults = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setRange({ from: "", through: "" }); setError(""); onPending(false); };
  const apply = (from: string, through: string, input: RuleInput | null) => {
    if (disabled) return;
    try { onChange(changeStaySeason(room, offer.id, from, through, input)); if (input) cancel(); else setError(""); }
    catch (cause) { setError(errorText(cause, t, "pricing.staySeasons.changeFailed")); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">{t("pricing.staySeasons.title", { label })}</summary>
    <p className="mt-2 text-gray-600">{t("pricing.staySeasons.description")}</p>
    <ul className="my-3 space-y-2">{offer.restrictions.seasons.map(({ from, through, rules }) => <li key={from} className="flex flex-wrap items-center gap-3">
      <span>{t("pricing.stay.summary", { when: `${from}–${through}`, min: rules.minArrivalNights, max: rules.maxStayNights ?? t("pricing.stay.unlimited"), arrivals: t(rules.closedToArrival ? "pricing.stay.closed" : "pricing.stay.open"), departures: t(rules.closedToDeparture ? "pricing.stay.closed" : "pricing.stay.open"), sales: t(rules.stopSell ? "pricing.stay.stopped" : "pricing.stay.open") })}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={t("pricing.staySeasons.clearLabel", { from, through, label })} onClick={() => apply(from, through, null)}>{t("pricing.staySeasons.clear")}</button>
    </li>)}</ul>
    {!entry ? <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => { if (disabled) return; setEntry(stayRuleInput(defaults)); setError(""); onPending(true); }}>{t("pricing.staySeasons.add")}</button> : <>
      <p className="my-3">{t("pricing.staySeasons.startingValues")}</p>
      <div className="flex flex-wrap gap-3">{([["from", t("pricing.seasonStart")], ["through", t("pricing.seasonEnd")]] as const).map(([key, name]) => <label key={key}>{name}<input aria-label={t("pricing.staySeasons.rangeInputLabel", { field: name, label })} className="mt-1 block w-40 rounded border px-3 py-2" value={range[key]} disabled={disabled} onChange={(event) => { setRange({ ...range, [key]: event.target.value }); setError(""); }} /></label>)}</div>
      <StayRuleFields entry={entry} label={t("pricing.staySeasons.ruleLabel", { label })} disabled={disabled} onChange={(next) => { setEntry(next); setError(""); }} />
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(range.from, range.through, entry)}>{t("pricing.staySeasons.apply")}</button>
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.staySeasons.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelEntry")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
