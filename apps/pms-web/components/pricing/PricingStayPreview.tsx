"use client";

import { useEffect, useState } from "react";
import { calculateReplacementRoomStay, pricingCurrencyScale, type RoomStayPricingResult } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";
import { decimalAmount, editedSnapshot, errorText, type MessageKey, PricingError } from "./pricingAmounts";

/** `roomTypeId` limits the choice to that room's offers (a room page). */
type Props = { snapshot: PricingSnapshot; inputs: Record<string, string>; disabled: boolean; saved: boolean; roomNames: Record<string, string>; roomTypeId?: string };
const reasons: Record<Extract<RoomStayPricingResult, { kind: "unavailable" }>["reason"], MessageKey> = {
  invalid_configuration: "pricing.preview.reasonInvalidConfiguration",
  invalid_request: "pricing.preview.reasonInvalidRequest",
  invalid_guests: "pricing.preview.reasonInvalidGuests",
  stale: "pricing.preview.reasonStale",
  missing_terms: "pricing.preview.reasonMissingTerms",
  missing_price: "pricing.preview.reasonMissingPrice",
  restriction: "pricing.preview.reasonRestriction",
  overflow: "pricing.preview.reasonOverflow",
};

export function PricingStayPreview({ snapshot, inputs, disabled, saved, roomNames, roomTypeId }: Props) {
  const [choice, setChoice] = useState(() => `${roomTypeId ? Math.max(0, snapshot.rooms.findIndex((room) => room.roomTypeId === roomTypeId)) : 0}:0`), [checkIn, setCheckIn] = useState(""), [checkOut, setCheckOut] = useState("");
  const [adults, setAdults] = useState("2"), [ages, setAges] = useState("");
  const [answer, setAnswer] = useState<{ key: string; result?: RoomStayPricingResult; error?: string } | null>(null);
  const { t } = useTranslation();
  const key = JSON.stringify([snapshot, inputs, disabled, saved, choice, checkIn, checkOut, adults, ages]);
  // Hide stale totals during render, then forget them so reverting an edit cannot revive a prior result.
  useEffect(() => { setAnswer(null); }, [key]);
  const shown = !disabled && answer?.key === key ? answer : null;
  const result = shown?.result;
  function preview() {
    if (disabled) return;
    try {
      if (!/^\d+$/.test(adults) || (ages.trim() && !/^\d+(\s*,\s*\d+)*$/.test(ages.trim()))) throw new PricingError("pricing.preview.errorGuests");
      if ((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000 > 366) throw new PricingError("pricing.preview.errorNights");
      const [ri, oi] = choice.split(":").map(Number), config = editedSnapshot(snapshot, inputs).rooms[ri], offer = config?.offers[oi];
      if (!config || !offer) throw new PricingError("pricing.preview.errorChoice");
      const result = calculateReplacementRoomStay(config, { propertyId: config.propertyId, roomTypeId: config.roomTypeId, offerId: offer.id,
        expectedRevision: config.revision, expectedTermsRevisions: Object.fromEntries(config.offers.map((item) => [item.id, item.termsRevision])),
        checkIn, checkOut, guests: { adults: Number(adults), childAgesAtCheckIn: ages.trim() ? ages.split(",").map((age) => Number(age.trim())) : [] } });
      setAnswer({ key, result });
    } catch (error) { setAnswer({ key, error: errorText(error, t, "pricing.preview.errorFailed") }); }
  }
  const money = (minor: string) => `${decimalAmount(minor, pricingCurrencyScale(snapshot.currency)!)} ${snapshot.currency}`;
  return <section aria-label={t("pricing.preview.label")} className="rounded-xl border bg-white p-5">
    <h2 className="font-semibold">{t("pricing.preview.title")}</h2>
    <p className="mt-2 text-sm text-gray-600">{t(saved ? "pricing.preview.saved" : "pricing.preview.unsaved")} {t("pricing.preview.scope")}</p>
    <fieldset disabled={disabled} className="mt-4 flex flex-wrap gap-4 disabled:opacity-50">
      <label className="text-sm">{t("pricing.preview.choice")}<select aria-label={t("pricing.preview.choiceLabel")} value={choice} onChange={(e) => setChoice(e.target.value)} className="mt-1 block rounded border p-2">
        {snapshot.rooms.flatMap((room, ri) => roomTypeId && room.roomTypeId !== roomTypeId ? [] : room.offers.map((offer, oi) => <option key={`${ri}:${oi}`} value={`${ri}:${oi}`}>{roomNames[room.roomTypeId] ?? t("pricing.roomNumber", { number: ri + 1 })} · {t("pricing.offerNumber", { number: oi + 1 })} · {t(`pricing.meal.${offer.meal.kind}`)}</option>))}
      </select></label>
      <label className="text-sm">{t("pricing.preview.checkIn")}<input aria-label={t("pricing.preview.checkInLabel")} type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="mt-1 block rounded border p-2" /></label>
      <label className="text-sm">{t("pricing.preview.checkOut")}<input aria-label={t("pricing.preview.checkOutLabel")} type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="mt-1 block rounded border p-2" /></label>
      <label className="text-sm">{t("pricing.preview.adults")}<input aria-label={t("pricing.preview.adultsLabel")} inputMode="numeric" maxLength={3} value={adults} onChange={(e) => setAdults(e.target.value)} className="mt-1 block w-20 rounded border p-2" /></label>
      <label className="text-sm">{t("pricing.preview.ages")}<input aria-label={t("pricing.preview.agesLabel")} placeholder={t("pricing.preview.agesPlaceholder")} maxLength={128} value={ages} onChange={(e) => setAges(e.target.value)} className="mt-1 block w-44 rounded border p-2" /></label>
      <button type="button" disabled={disabled} onClick={preview} className="self-end rounded-lg border border-emerald-700 px-4 py-2 text-emerald-800">{t("pricing.preview.calculate")}</button>
    </fieldset>
    {disabled && <p className="mt-3 text-sm">{t("pricing.preview.disabled")}</p>}
    {(shown?.error || result?.kind === "unavailable") && <p role="alert" className="mt-3 text-sm text-red-800">{shown?.error ?? (result?.kind === "unavailable" ? t(reasons[result.reason]) : "")}</p>}
    {result?.kind === "priced" && <div role="status" className="mt-4 space-y-2">
      <p className="font-semibold">{t("pricing.preview.estimate", { amount: money(result.totalMinor) })}</p>
      <p className="text-sm">{t(result.nights.length === 1 ? "pricing.preview.summary.one" : "pricing.preview.summary.other", { room: money(result.roomMinor), meal: money(result.mealMinor), count: result.nights.length })}</p>
      <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-sm [&_td]:pr-4 [&_td]:py-1 [&_th]:pr-4"><caption className="sr-only">{t("pricing.preview.caption")}</caption><thead><tr><th scope="col">{t("pricing.preview.night")}</th><th scope="col">{t("pricing.preview.room")}</th><th scope="col">{t("pricing.preview.meals")}</th><th scope="col">{t("pricing.preview.total")}</th><th scope="col">{t("pricing.preview.rules")}</th></tr></thead>
        <tbody>{result.nights.map((night) => <tr key={night.date}><td>{night.date}</td><td>{money(night.roomMinor)}</td><td>{money(night.mealMinor)}</td><td>{money(night.totalMinor)}</td><td>{night.sources.map((source) => `${t("pricing.offerNumber", { number: snapshot.rooms.find((room) => room.roomTypeId === result.roomTypeId)!.offers.findIndex((offer) => offer.id === source.offerId) + 1 })}: ${t(`pricing.preview.source.${source.kind}`)}`).join(", ")}</td></tr>)}</tbody>
      </table></div>
    </div>}
  </section>;
}
