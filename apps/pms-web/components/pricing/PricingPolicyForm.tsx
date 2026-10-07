"use client";

import { useState } from "react";
import { parseBookingPricingOfferTerms, type ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { AcceptedPaymentMethods, type PaymentMethod } from "./AcceptedPaymentMethods";
import { decimalAmount, errorText, parseMinorInput, PricingError } from "./pricingAmounts";

export function PricingPolicyForm({ terms, disabled, onApply, onCancel }: { terms: ReplacementOfferTerms; disabled: boolean;
  onApply(value: ReplacementOfferTerms): void; onCancel(): void }) {
  const original = terms.cancellation.kind === "flexible" ? terms.cancellation.terms : null;
  const [kind, setKind] = useState(terms.cancellation.kind), [payment, setPayment] = useState(terms.payment.kind);
  const [methods, setMethods] = useState<PaymentMethod[]>([...(terms.payment.acceptedMethods ?? [])]);
  const [values, setValues] = useState({ deadline: String(original?.freeCancellationDeadlineDays ?? 7), type: original?.flexibleCancellationType ?? "",
    window: original?.partialRefundCancelWindowDays?.toString() ?? "", percent: original?.partialRefundAmountPercent?.toString() ?? "", text: original?.text ?? "",
    deposit: terms.payment.kind === "deposit" ? decimalAmount(String(terms.payment.basisPoints), 2) : "30", balance: terms.payment.kind === "deposit" ? String(terms.payment.balanceDaysBeforeArrival) : "7" });
  const [tiers, setTiers] = useState((original?.partialRefundTiers ?? []).map((t) => ({ days: String(t.minDaysBeforeCheckIn), percent: String(t.refundPercent) })));
  const [error, setError] = useState("");
  const { t } = useTranslation();
  const integer = (v: string) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : NaN;
  function apply() {
    if (disabled) return;
    try {
      if (!methods.length) throw new PricingError("pricing.error.paymentMethodRequired");
      const cancellation = kind === "non_refundable" ? { kind } : { kind, terms: {
        type: "free_until_days_before_arrival", freeCancellationDeadlineDays: integer(values.deadline), afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount",
        ...(values.type ? { flexibleCancellationType: values.type } : {}), ...(values.window ? { partialRefundCancelWindowDays: integer(values.window) } : {}),
        ...(values.percent ? { partialRefundAmountPercent: integer(values.percent) } : {}), ...(values.text ? { text: values.text } : {}),
        ...(tiers.length || original?.partialRefundTiers !== undefined ? { partialRefundTiers: tiers.map((t) => ({ minDaysBeforeCheckIn: integer(t.days), refundPercent: integer(t.percent) })) } : {}),
      } };
      const parsed = parseBookingPricingOfferTerms({ ...terms, cancellation, payment: payment === "full" ? { kind: payment, acceptedMethods: methods } : {
        kind: payment, basisPoints: Number(parseMinorInput(values.deposit, 2)), balanceDaysBeforeArrival: integer(values.balance), acceptedMethods: methods,
      } });
      if (!parsed) throw new PricingError("pricing.policy.errorInvalid");
      onApply(parsed);
    } catch (e) { setError(errorText(e, t, "pricing.policy.errorCheck")); }
  }
  const field = (key: keyof typeof values, label: string) => <label className="block text-sm">{label}<input aria-label={label} value={values[key]} inputMode="decimal"
    className="mt-1 block w-full rounded border px-3 py-2" onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></label>;
  return <fieldset disabled={disabled} className="mt-3 space-y-3 rounded-lg border bg-gray-50 p-4">
    <legend className="font-medium">{t("pricing.policy.title")}</legend>
    <label className="block text-sm">{t("pricing.cancellationPolicy")}<select aria-label={t("pricing.cancellationPolicy")} className="mt-1 block w-full rounded border p-2" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
      <option value="non_refundable">{t("pricing.nonRefundable")}</option><option value="flexible">{t("pricing.policy.flexible")}</option></select></label>
    {kind === "flexible" && <>
      {field("deadline", t("pricing.policy.deadline"))}
      <label className="block text-sm">{t("pricing.policy.flexibleType")}<select aria-label={t("pricing.policy.flexibleType")} className="mt-1 block w-full rounded border p-2" value={values.type} onChange={(e) => setValues({ ...values, type: e.target.value as typeof values.type })}>
        <option value="">{t("pricing.policy.typeUnspecified")}</option><option value="free">{t("pricing.policy.typeFree")}</option><option value="partial_refund">{t("pricing.policy.typePartialRefund")}</option></select></label>
      <p className="text-sm">{t("pricing.policy.penalty")}</p>
      {field("window", t("pricing.policy.window"))}{field("percent", t("pricing.policy.percent"))}
      <p className="text-sm">{t("pricing.policy.tiersHint")}</p>
      {tiers.map((tier, i) => <div key={i} className="flex flex-wrap items-end gap-2">
        {(["days", "percent"] as const).map((key) => <label key={key} className="text-sm">{t(key === "days" ? "pricing.policy.tierDays" : "pricing.policy.tierPercent")}<input aria-label={t(key === "days" ? "pricing.policy.tierDaysLabel" : "pricing.policy.tierPercentLabel", { number: i + 1 })} inputMode="numeric" value={tier[key]} className="mt-1 block w-32 rounded border p-2" onChange={(e) => setTiers(tiers.map((t, j) => j === i ? { ...t, [key]: e.target.value } : t))} /></label>)}
        <button type="button" className="rounded border px-3 py-2" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>{t("pricing.policy.removeTier", { number: i + 1 })}</button>
      </div>)}
      <button type="button" disabled={disabled || tiers.length >= 10} className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => setTiers([...tiers, { days: "", percent: "" }])}>{t("pricing.policy.addTier")}</button>
      <label className="block text-sm">{t("pricing.policy.text")}<textarea aria-label={t("pricing.policy.text")} className="mt-1 block w-full rounded border p-2" rows={3} value={values.text} onChange={(e) => setValues({ ...values, text: e.target.value })} /></label>
      <p className="text-xs text-gray-600">{t("pricing.policy.switchHint")}</p>
    </>}
    <label className="block text-sm">{t("pricing.policy.schedule")}<select aria-label={t("pricing.policy.schedule")} className="mt-1 block w-full rounded border p-2" value={payment} onChange={(e) => setPayment(e.target.value as typeof payment)}>
      <option value="full">{t("pricing.fullPayment")}</option><option value="deposit">{t("pricing.policy.depositAndBalance")}</option></select></label>
    {payment === "deposit" && <>{field("deposit", t("pricing.policy.deposit"))}{field("balance", t("pricing.policy.balance"))}
      <p className="text-sm text-amber-900">{t("pricing.policy.depositUnavailable")}</p></>}
    <AcceptedPaymentMethods methods={methods} disabled={disabled} onChange={setMethods} />
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <p className="text-sm">{t("pricing.policy.applyHint")}</p>
    <div className="flex gap-2"><button type="button" className="rounded bg-emerald-700 px-3 py-2 text-white" onClick={apply}>{t("pricing.policy.apply")}</button>
      <button type="button" className="rounded border px-3 py-2" onClick={onCancel}>{t("pricing.policy.cancel")}</button></div>
  </fieldset>;
}
