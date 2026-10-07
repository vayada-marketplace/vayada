"use client";
import { useState } from "react";
import { parsePricingConfiguration, pricingCurrencyScale, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseMinorInput, PricingError } from "./pricingAmounts";

type Offer = PricingConfiguration["offers"][number];
type Entry = { kind: string; basis: string; amounts: string[] };
const mealKinds = ["room_only", "breakfast", "half_board", "full_board", "all_inclusive"];
export function changeMealPlan(room: PricingConfiguration, offerId: string, entry: Entry): PricingConfiguration {
  if (!room.offers.some((offer) => offer.id === offerId)) throw new PricingError("pricing.error.offerMissing");
  const scale = pricingCurrencyScale(room.currency), noMeal = entry.kind === "room_only";
  if (scale === null || !mealKinds.includes(entry.kind) || !["room", "person"].includes(entry.basis)) throw new PricingError("pricing.mealPlan.errorPlan");
  const count = noMeal ? 0 : entry.basis === "room" ? 1 : room.children.bands.length + 1;
  if (entry.amounts.length !== count || (noMeal && entry.basis !== "room")) throw new PricingError("pricing.mealPlan.errorAmounts");
  const amounts = Array.from(entry.amounts, (amount) => parseMinorInput(amount, scale, true));
  const charge = noMeal ? { kind: "room", amountMinor: "0" } : entry.basis === "room" ? { kind: "room", amountMinor: amounts[0] } : { kind: "person", adultMinor: amounts[0], childBandAmountsMinor: amounts.slice(1) };
  const result = parsePricingConfiguration({ ...room, offers: room.offers.map((offer) => offer.id === offerId ? { ...offer, meal: { kind: entry.kind, charge } } : offer) });
  if (!result) throw new PricingError("pricing.error.mealConfigInvalid");
  return result;
}

export function PricingMealPlan({ room, offer, label, disabled, blocked, onChange, onPending }: { room: PricingConfiguration; offer: Offer; label: string; disabled: boolean; blocked: boolean;
  onChange: (room: PricingConfiguration) => void; onPending: (pending: boolean) => void }) {
  const [entry, setEntry] = useState<Entry | null>(null), [ack, setAck] = useState(false), [error, setError] = useState("");
  const { t } = useTranslation();
  const cancel = () => { setEntry(null); setAck(false); setError(""); onPending(false); };
  const update = (next: Entry) => { setEntry(next); setAck(false); setError(""); };
  const choose = (kind: string, basis: string) => update({ kind, basis: kind === "room_only" ? "room" : basis, amounts: Array(kind === "room_only" ? 0 : basis === "room" ? 1 : room.children.bands.length + 1).fill("") });
  const labels = entry?.basis === "person" ? [t("pricing.perAdult"), ...room.children.bands.map((band) => t("pricing.perChildAges", { from: band.fromAge, through: band.throughAge }))] : [t("pricing.perRoom")];
  return <div className="sm:col-span-2 rounded-lg border p-3 text-sm">
    <p>{t("pricing.mealPlan.current", { label, meal: t(`pricing.meal.${offer.meal.kind}`) })}</p>
    {!entry ? <button type="button" className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || blocked} onClick={() => {
      if (disabled || blocked) return;
      const charge = offer.meal.charge, amounts = offer.meal.kind === "room_only" ? [] : charge.kind === "room" ? [charge.amountMinor] : [charge.adultMinor, ...charge.childBandAmountsMinor];
      setEntry({ kind: offer.meal.kind, basis: charge.kind, amounts: amounts.map((minor) => decimalAmount(minor, pricingCurrencyScale(room.currency)!)) }); setAck(false); setError(""); onPending(true);
    }}>{t("pricing.mealPlan.change")}</button> : <>
      <p className="mt-2">{t("pricing.mealPlan.description")}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <label>{t("pricing.mealPlan.label")}<select aria-label={t("pricing.mealPlan.selectLabel", { label })} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={entry.kind} onChange={(event) => choose(event.target.value, entry.basis)}>{mealKinds.map((kind) => <option key={kind} value={kind}>{t(`pricing.meal.${kind}`)}</option>)}</select></label>
        {entry.kind !== "room_only" && <label>{t("pricing.mealPlan.chargePer")}<select aria-label={t("pricing.mealPlan.basisLabel", { label })} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={entry.basis} onChange={(event) => choose(entry.kind, event.target.value)}><option value="room">{t("pricing.mealPlan.basisRoom")}</option><option value="person">{t("pricing.mealPlan.basisPerson")}</option></select></label>}
      </div>
      {entry.basis === "person" && <p className="mt-2">{t("pricing.mealPlan.ages", { age: room.children.adultFromAge })}</p>}
      <div className="mt-3 flex flex-wrap gap-3">{entry.amounts.map((amount, index) => <label key={index}>{t("pricing.mealPlan.amountLabel", { charge: labels[index], currency: room.currency })}<input aria-label={t("pricing.mealPlan.inputLabel", { charge: labels[index], label })} className="mt-1 block w-36 rounded border px-3 py-2" inputMode="decimal" disabled={disabled} value={amount} onChange={(event) => update({ ...entry, amounts: entry.amounts.map((value, i) => i === index ? event.target.value : value) })} /></label>)}</div>
      <p className="mt-2">{t("pricing.mealPlan.clearsAmounts")}</p>
      <label className="mt-3 flex gap-2"><input type="checkbox" disabled={disabled} checked={ack} onChange={(event) => setAck(event.target.checked)} />{t("pricing.mealPlan.acknowledge", { label })}</label>
      <div className="mt-3 flex gap-3"><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled || !ack} onClick={() => {
        if (disabled || !ack) return;
        try { onChange(changeMealPlan(room, offer.id, entry)); cancel(); } catch (cause) { setError(errorText(cause, t, "pricing.mealPlan.changeFailed")); }
      }}>{t("pricing.mealPlan.apply")}</button><button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled} onClick={cancel}>{t("pricing.mealPlan.cancel")}</button></div>
      <p className="mt-2">{t("pricing.applyOrCancelBeforeOtherRules")}</p>
    </>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
