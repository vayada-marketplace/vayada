"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseMinorInput, PricingError } from "./pricingAmounts";

export function changeChildCharges(room: PricingConfiguration, amounts: readonly string[]): PricingConfiguration {
  if (amounts.length !== room.children.bands.length) throw new PricingError("pricing.childCharges.errorBands");
  const scale = pricingCurrencyScale(room.currency);
  if (scale === null) throw new PricingError("pricing.error.currencyUnavailable");
  const bands = room.children.bands.map((band, index) => ({ ...band, nightlyMinor: parseMinorInput(amounts[index], scale, true) }));
  const result = parsePricingConfiguration({ ...room, children: { ...room.children, bands } });
  if (!result) throw new PricingError("pricing.childCharges.errorInvalid");
  return result;
}

export function PricingChildCharges({ room, label, disabled, onChange, onPending }: { room: PricingConfiguration; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<string[] | null>(null), [error, setError] = useState("");
  const { t } = useTranslation();
  const scale = pricingCurrencyScale(room.currency)!;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <details className="border-b p-5 text-sm"><summary className="cursor-pointer">{t("pricing.childCharges.title", { label })}</summary>
    <p className="mt-2 text-gray-600">{t("pricing.childCharges.description", { age: room.children.adultFromAge })}</p>
    <ul className="mt-3 space-y-3">{room.children.bands.map((band, index) => <li key={band.fromAge}>
      <p>{t("pricing.childCharges.band", { from: band.fromAge, through: band.throughAge, amount: decimalAmount(band.nightlyMinor, scale), currency: room.currency })} {t(band.countsTowardCapacity ? "pricing.childCharges.countsTowardCapacity" : "pricing.childCharges.notCountsTowardCapacity")} {t("pricing.childCharges.childLimit")}</p>
      {entry && <label className="mt-2 block">{t("pricing.childCharges.nightlyCharge", { currency: room.currency })}<input aria-label={t("pricing.childCharges.inputLabel", { from: band.fromAge, through: band.throughAge, label })} inputMode="decimal" className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={entry[index]} onChange={(event) => { setEntry(entry.map((value, i) => i === index ? event.target.value : value)); setError(""); }} /></label>}
    </li>)}</ul>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
      if (disabled) return; setEntry(room.children.bands.map((band) => decimalAmount(band.nightlyMinor, scale))); setError(""); onPending(true);
    }}>{t("pricing.childCharges.edit")}</button> : <>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeChildCharges(room, entry)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.childCharges.changeFailed")); }
      }}>{t("pricing.childCharges.apply")}</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.childCharges.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelEdit")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </details>;
}
