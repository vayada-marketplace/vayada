"use client";
import { useState } from "react";
import { parsePricingConfiguration, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { AcceptedPaymentMethods, type PaymentMethod } from "./AcceptedPaymentMethods";
import { errorText, parseAdjustmentInput, PricingError } from "./pricingAmounts";

type Values = { parent: string; kind: string; value: string; cancellation: string; deadline: string; payment: string; methods: PaymentMethod[] };
export function linkedOfferInput(room: PricingConfiguration, offerId: string, values: Values) {
  if (!room.offers.some((offer) => offer.id === values.parent) || values.payment !== "full" || !["non_refundable", "flexible"].includes(values.cancellation)) throw new PricingError("pricing.linkedOffer.errorRequired");
  if (!values.methods.length) throw new PricingError("pricing.error.paymentMethodRequired");
  const cancellation: PricingTermsInput["cancellation"] = values.cancellation === "non_refundable" ? { kind: "non_refundable" } : { kind: "flexible", terms: {
    type: "free_until_days_before_arrival", freeCancellationDeadlineDays: /^\d+$/.test(values.deadline) ? Number(values.deadline) : NaN, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } };
  const terms: PricingTermsInput = { roomTypeId: room.roomTypeId, offerId, expectedRevision: null, cancellation, payment: { kind: "full", acceptedMethods: values.methods } };
  if (!parseBookingPricingOfferTerms({ roomTypeId: room.roomTypeId, offerId, revision: offerId, cancellation, payment: terms.payment })) throw new PricingError("pricing.error.cancellationDeadline");
  const configuration = parsePricingConfiguration({ ...room, offers: [...room.offers, { id: offerId, termsRevision: offerId,
    meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } }, restrictions: { kind: "inherit" },
    price: { kind: "linked", parentId: values.parent, adjustment: parseAdjustmentInput(values, room.currency), dateOverrides: [] } }] });
  if (!configuration) throw new PricingError("pricing.linkedOffer.errorConfiguration");
  return { configuration, terms };
}

export function NewLinkedOffer({ room, disabled, onCreate }: { room: PricingConfiguration; disabled: boolean; onCreate: (input: ReturnType<typeof linkedOfferInput>) => void }) {
  const [values, setValues] = useState<Values>({ parent: "", kind: "", value: "", cancellation: "", deadline: "", payment: "", methods: [] }), [error, setError] = useState("");
  const { t } = useTranslation();
  const change = (key: Exclude<keyof Values, "methods">, value: string) => { setValues({ ...values, [key]: value, ...(key === "kind" ? { value: "" } : {}) }); setError(""); };
  const select = (key: Exclude<keyof Values, "methods">, label: string, options: [string, string][]) => <label>{label}<select aria-label={label} className="mt-1 block rounded border px-3 py-2" disabled={disabled} value={values[key]} onChange={(event) => change(key, event.target.value)}><option value="">{t("pricing.choose")}</option>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <form className="space-y-3 text-sm" onSubmit={(event) => {
    event.preventDefault(); if (disabled) return;
    try { onCreate(linkedOfferInput(room, crypto.randomUUID(), values)); } catch (cause) { setError(errorText(cause, t, "pricing.linkedOffer.errorCheck")); }
  }}>
    <h3 className="font-semibold">{t("pricing.linkedOffer.title")}</h3>
    <p>{t("pricing.linkedOffer.intro")}</p>
    <div className="flex flex-wrap gap-3">
      {select("parent", t("pricing.linkedOffer.parent"), room.offers.map((offer, index) => [offer.id, t("pricing.offerNumber", { number: index + 1 })]))}
      {select("kind", t("pricing.linkedOffer.adjustmentType"), [["fixed", t("pricing.amountIn", { currency: room.currency })], ["percentage", t("pricing.percentage")]])}
      <label>{t("pricing.adjustmentWithUnit", { unit: values.kind === "percentage" ? "%" : room.currency })}<input aria-label={t("pricing.linkedOffer.adjustment")} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values.value} onChange={(event) => change("value", event.target.value)} /></label>
      {select("cancellation", t("pricing.linkedOffer.cancellation"), [["non_refundable", t("pricing.nonRefundable")], ["flexible", t("pricing.freeCancellationUntilDeadline")]])}
      {values.cancellation === "flexible" && <label>{t("pricing.freeCancellationDays")}<input aria-label={t("pricing.linkedOffer.deadline")} className="mt-1 block w-36 rounded border px-3 py-2" disabled={disabled} value={values.deadline} onChange={(event) => change("deadline", event.target.value)} /></label>}
      {select("payment", t("pricing.linkedOffer.payment"), [["full", t("pricing.fullPayment")]])}
    </div>
    <AcceptedPaymentMethods methods={values.methods} disabled={disabled} onChange={(methods) => { setValues({ ...values, methods }); setError(""); }} />
    <p>{t("pricing.linkedOffer.adjustmentHint")}</p>
    <p>{t("pricing.linkedOffer.continueHint")}</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <button disabled={disabled} className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50">{t("pricing.linkedOffer.continue")}</button>
  </form>;
}
