"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseAdjustmentInput, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
export function changeWeekdayPrice(room: PricingConfiguration, offerId: string, day: string, input: { kind: string; value: string } | null, replace = false): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "independent") throw new PricingError("pricing.weekdays.errorIndependent");
  if (!/^[0-6]$/.test(day)) throw new PricingError("pricing.weekdays.errorDay");
  const weekdays = offer.price.calendar.weekdays, exists = weekdays.some((entry) => entry.day === Number(day));
  if (replace && (!exists || !input)) throw new PricingError("pricing.weekdays.errorEditMissing");
  if (input && exists && !replace) throw new PricingError("pricing.weekdays.errorExists");
  if (!input && !exists) throw new PricingError("pricing.weekdays.errorNothingToClear");
  let next = weekdays.filter((entry) => entry.day !== Number(day));
  if (input) {
    const adjustment = parseAdjustmentInput(input, room.currency);
    next = [...next, { day: Number(day), adjustment }].sort((a, b) => a.day - b.day);
  }
  const price = { ...offer.price, calendar: { ...offer.price.calendar, weekdays: next } };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...offer, price } : value) });
  if (!result) throw new PricingError("pricing.weekdays.errorRange");
  return result;
}

export function PricingWeekdays({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState({ day: "", kind: "", value: "" }), [error, setError] = useState(""), [editing, setEditing] = useState(false);
  if (offer.price.kind !== "independent") return null;
  const pending = !!(entry.day || entry.kind || entry.value);
  const update = (next: typeof entry) => { setEntry(next); setError(""); onPending(!!(next.day || next.kind || next.value)); };
  const reset = () => { setEditing(false); update({ day: "", kind: "", value: "" }); };
  const apply = (day: string, input: { kind: string; value: string } | null) => {
    if (disabled || (!input && pending)) return;
    try { onChange(changeWeekdayPrice(room, offer.id, day, input, editing)); if (input) reset(); else setError(""); }
    catch (cause) { setError(errorText(cause, t, "pricing.weekdays.changeFailed")); }
  };
  return <details className="sm:col-span-2 text-sm"><summary className="cursor-pointer">{t("pricing.weekdays.summary", { label })}</summary>
    <p className="mt-2 text-gray-600">{t("pricing.weekdays.intro")}</p>
    <ul className="my-3 space-y-2">{offer.price.calendar.weekdays.map(({ day, adjustment }) => <li key={day} className="flex flex-wrap items-center gap-3">
      <span>{t(`pricing.weekday.${day}`)}: {adjustment.kind === "percentage" ? `${adjustment.basisPoints / 100}%` : `${adjustment.deltaMinor.startsWith("-") ? "−" : "+"}${decimalAmount(adjustment.deltaMinor.replace(/^-/, ""), pricingCurrencyScale(room.currency)!)} ${room.currency}`}</span>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={t("pricing.weekdays.editAria", { day: t(`pricing.weekday.${day}`), label })} onClick={() => {
        if (disabled || pending) return;
        const minor = adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
        setEditing(true); update({ day: String(day), kind: adjustment.kind, value: `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? pricingCurrencyScale(room.currency)! : 2)}` });
      }}>{t("pricing.weekdays.edit")}</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-50" disabled={disabled || pending} aria-label={t("pricing.weekdays.clearAria", { day: t(`pricing.weekday.${day}`), label })} onClick={() => apply(String(day), null)}>{t("pricing.weekdays.clear")}</button>
    </li>)}</ul>
    <div className="flex flex-wrap items-end gap-3">
      <label>{t("pricing.weekdays.weekday")}<select aria-label={t("pricing.weekdays.weekdayAria", { label })} className="mt-1 block rounded border px-3 py-2" disabled={disabled || editing} value={entry.day} onChange={(event) => { if (!disabled && !editing) update({ ...entry, day: event.target.value }); }}>
        <option value="">{t("pricing.choose")}</option>{Array.from({ length: 7 }, (_, day) => <option key={day} value={day}>{t(`pricing.weekday.${day}`)}</option>)}
      </select></label>
      <label>{t("pricing.adjustmentType")}<select aria-label={t("pricing.weekdays.typeAria", { label })} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={entry.kind} onChange={(event) => update({ ...entry, kind: event.target.value, value: "" })}>
        <option value="">{t("pricing.choose")}</option><option value="fixed">{t("pricing.amountIn", { currency: room.currency })}</option><option value="percentage">{t("pricing.percentage")}</option>
      </select></label>
      <label>{t("pricing.adjustmentWithUnit", { unit: entry.kind === "percentage" ? "%" : room.currency })}<input aria-label={t("pricing.weekdays.amountAria", { label })} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry.value} onChange={(event) => update({ ...entry, value: event.target.value })} /></label>
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => apply(entry.day, entry)}>{editing ? t("pricing.weekdays.apply") : t("pricing.weekdays.add")}</button>
      {pending && <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={reset}>{t("pricing.weekdays.cancel")}</button>}
    </div>
    {pending && <p className="mt-2">{editing ? t("pricing.weekdays.pendingApply") : t("pricing.weekdays.pendingAdd")}</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
