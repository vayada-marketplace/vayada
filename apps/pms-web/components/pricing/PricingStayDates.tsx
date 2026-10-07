"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText, PricingError } from "./pricingAmounts";
import { StayRuleFields, stayRuleInput, stayRules, type RuleInput } from "./StayRuleFields";
type Offer = PricingConfiguration["offers"][number];

export function changeStayDate(room: PricingConfiguration, offerId: string, date: string, input: RuleInput | null): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.restrictions.kind !== "own") throw new PricingError("pricing.error.stayRuleOwner");
  const exists = offer.restrictions.dates.some((entry) => entry.date === date);
  if (input && exists) throw new PricingError("pricing.stayDates.errorExists");
  if (!input && !exists) throw new PricingError("pricing.stayDates.errorNothingToClear");
  const dates = input ? [...offer.restrictions.dates, { date, rules: stayRules(input) }] : offer.restrictions.dates.filter((entry) => entry.date !== date);
  const restrictions = { ...offer.restrictions, dates };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, restrictions } : value) });
  if (!result) throw new PricingError("pricing.stayDates.errorInvalid");
  return result;
}

export function PricingStayDates({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<RuleInput | null>(null), [date, setDate] = useState(""), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.restrictions.kind !== "own") return null;
  const defaults = offer.restrictions.rules;
  const cancel = () => { setEntry(null); setDate(""); setError(""); onPending(false); };
  const apply = (day: string, input: RuleInput | null) => {
    if (disabled) return;
    try { onChange(changeStayDate(room, offer.id, day, input)); if (input) cancel(); else setError(""); }
    catch (cause) { setError(errorText(cause, t, "pricing.stayDates.changeFailed")); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">{t("pricing.stayDates.title", { label })}</summary>
    <p className="mt-2 text-gray-600">{t("pricing.stayDates.description")}</p>
    <ul className="my-3 space-y-2">{offer.restrictions.dates.map(({ date: day, rules }) => <li key={day} className="flex flex-wrap items-center gap-3">
      <span>{t("pricing.stay.summary", { when: day, min: rules.minArrivalNights, max: rules.maxStayNights ?? t("pricing.stay.unlimited"), arrivals: t(rules.closedToArrival ? "pricing.stay.closed" : "pricing.stay.open"), departures: t(rules.closedToDeparture ? "pricing.stay.closed" : "pricing.stay.open"), sales: t(rules.stopSell ? "pricing.stay.stopped" : "pricing.stay.open") })}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled} aria-label={t("pricing.stayDates.clearLabel", { date: day, label })} onClick={() => apply(day, null)}>{t("pricing.stayDates.clear")}</button>
    </li>)}</ul>
    {!entry ? <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => { if (disabled) return; setEntry(stayRuleInput(defaults)); setError(""); onPending(true); }}>{t("pricing.stayDates.add")}</button> : <>
      <p className="my-3">{t("pricing.stayDates.startingValues")}</p>
      <label>{t("pricing.dateLabel")}<input aria-label={t("pricing.stayDates.dateInputLabel", { label })} className="mt-1 block w-40 rounded border px-3 py-2" value={date} disabled={disabled} onChange={(event) => { setDate(event.target.value); setError(""); }} /></label>
      <StayRuleFields entry={entry} label={t("pricing.stayDates.ruleLabel", { label })} disabled={disabled} onChange={(next) => { setEntry(next); setError(""); }} />
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(date, entry)}>{t("pricing.stayDates.apply")}</button>
        <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.stayDates.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelEntry")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
