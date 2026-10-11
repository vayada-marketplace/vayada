"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseAdjustmentInput, PricingError } from "./pricingAmounts";
import { PricingSection } from "./PricingSection";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
type Entry = { kind: string; value: string };
export function changeLinkedAdjustment(room: PricingConfiguration, offerId: string, input: Entry): PricingConfiguration {
  const offer = room.offers.find((value) => value.id === offerId);
  if (!offer || offer.price.kind !== "linked") throw new PricingError("pricing.error.linkedOfferRequired");
  const price = { ...offer.price, adjustment: parseAdjustmentInput(input, room.currency) };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((value) => value.id === offerId ? { ...value, price } : value) });
  if (!result) throw new PricingError("pricing.linkedAdjustment.errorRange");
  return result;
}

export function PricingLinkedAdjustment({ room, offer, label, disabled, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<Entry | null>(null), [error, setError] = useState("");
  const { t } = useTranslation();
  if (offer.price.kind !== "linked") return null;
  const { adjustment, parentId } = offer.price;
  const minor = adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
  const value = `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? pricingCurrencyScale(room.currency)! : 2)}`;
  const cancel = () => { setEntry(null); setError(""); onPending(false); };
  return <PricingSection title={t("pricing.linkedAdjustment.section")} label={t("pricing.linkedAdjustment.title", { label })} keepOpen={!!entry}>
    <p className="mt-2">{t("pricing.linkedAdjustment.current", { number: room.offers.findIndex((candidate) => candidate.id === parentId) + 1, adjustment: `${value}${adjustment.kind === "percentage" ? "%" : ` ${room.currency}`}` })}</p>
    <p className={ui.help}>{t("pricing.linkedAdjustment.description")}</p>
    {!entry ? <button type="button" className={ui.secondaryButton} disabled={disabled} onClick={() => {
      if (disabled) return; setEntry({ kind: adjustment.kind, value }); setError(""); onPending(true);
    }}>{t("pricing.linkedAdjustment.edit")}</button> : <>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className={ui.fieldLabel}>{t("pricing.adjustmentType")}<select aria-label={t("pricing.linkedAdjustment.typeLabel", { label })} className={`mt-1.5 block ${ui.field}`} disabled={disabled} value={entry.kind} onChange={(event) => { setEntry({ kind: event.target.value, value: "" }); setError(""); }}>
          <option value="fixed">{t("pricing.amountIn", { currency: room.currency })}</option><option value="percentage">{t("pricing.percentage")}</option>
        </select></label>
        <label className={ui.fieldLabel}>{t("pricing.adjustmentWithUnit", { unit: entry.kind === "percentage" ? "%" : room.currency })}<input aria-label={t("pricing.linkedAdjustment.inputLabel", { label })} className={`mt-1.5 block w-36 ${ui.field}`} disabled={disabled} value={entry.value} onChange={(event) => { setEntry({ ...entry, value: event.target.value }); setError(""); }} /></label>
      </div>
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondaryButton} disabled={disabled} onClick={() => {
        if (disabled) return;
        try { onChange(changeLinkedAdjustment(room, offer.id, entry)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.linkedAdjustment.changeFailed")); }
      }}>{t("pricing.linkedAdjustment.apply")}</button><button type="button" className={ui.secondaryButton} disabled={disabled} onClick={cancel}>{t("pricing.linkedAdjustment.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelEdit")}</p>
    </>}
    {error && <p role="alert" className={ui.errorText}>{error}</p>}
  </PricingSection>;
}
