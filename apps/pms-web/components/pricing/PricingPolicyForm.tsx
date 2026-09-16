"use client";

import { useState } from "react";
import { parseBookingPricingOfferTerms, type ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { decimalAmount, parseMinorInput } from "./pricingAmounts";

export function PricingPolicyForm({ terms, disabled, onApply, onCancel }: { terms: ReplacementOfferTerms; disabled: boolean;
  onApply(value: ReplacementOfferTerms): void; onCancel(): void }) {
  const original = terms.cancellation.kind === "flexible" ? terms.cancellation.terms : null;
  const [kind, setKind] = useState(terms.cancellation.kind), [payment, setPayment] = useState(terms.payment.kind);
  const [values, setValues] = useState({ deadline: String(original?.freeCancellationDeadlineDays ?? 7), type: original?.flexibleCancellationType ?? "",
    window: original?.partialRefundCancelWindowDays?.toString() ?? "", percent: original?.partialRefundAmountPercent?.toString() ?? "", text: original?.text ?? "",
    deposit: terms.payment.kind === "deposit" ? decimalAmount(String(terms.payment.basisPoints), 2) : "30", balance: terms.payment.kind === "deposit" ? String(terms.payment.balanceDaysBeforeArrival) : "7" });
  const [tiers, setTiers] = useState((original?.partialRefundTiers ?? []).map((t) => ({ days: String(t.minDaysBeforeCheckIn), percent: String(t.refundPercent) })));
  const [error, setError] = useState("");
  const integer = (v: string) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : NaN;
  function apply() {
    if (disabled) return;
    try {
      const cancellation = kind === "non_refundable" ? { kind } : { kind, terms: {
        type: "free_until_days_before_arrival", freeCancellationDeadlineDays: integer(values.deadline), afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount",
        ...(values.type ? { flexibleCancellationType: values.type } : {}), ...(values.window ? { partialRefundCancelWindowDays: integer(values.window) } : {}),
        ...(values.percent ? { partialRefundAmountPercent: integer(values.percent) } : {}), ...(values.text ? { text: values.text } : {}),
        ...(tiers.length || original?.partialRefundTiers !== undefined ? { partialRefundTiers: tiers.map((t) => ({ minDaysBeforeCheckIn: integer(t.days), refundPercent: integer(t.percent) })) } : {}),
      } };
      const parsed = parseBookingPricingOfferTerms({ ...terms, cancellation, payment: payment === "full" ? { kind: payment } : {
        kind: payment, basisPoints: Number(parseMinorInput(values.deposit, 2)), balanceDaysBeforeArrival: integer(values.balance),
      } });
      if (!parsed) throw new Error("Check the policy fields. Days must be whole numbers; cancellation deadlines are 0–365, tier refunds 0–100%, and partial-refund policies need at least one tier with a unique deadline.");
      onApply(parsed);
    } catch (e) { setError(e instanceof Error ? e.message : "Check the policy fields."); }
  }
  const field = (key: keyof typeof values, label: string) => <label className="block text-sm">{label}<input aria-label={label} value={values[key]} inputMode="decimal"
    className="mt-1 block w-full rounded border px-3 py-2" onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></label>;
  return <fieldset disabled={disabled} className="mt-3 space-y-3 rounded-lg border bg-gray-50 p-4">
    <legend className="font-medium">Edit cancellation and payment</legend>
    <label className="block text-sm">Cancellation policy<select aria-label="Cancellation policy" className="mt-1 block w-full rounded border p-2" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
      <option value="non_refundable">Non-refundable</option><option value="flexible">Flexible</option></select></label>
    {kind === "flexible" && <>
      {field("deadline", "Free cancellation deadline (days before arrival)")}
      <label className="block text-sm">Flexible cancellation type<select aria-label="Flexible cancellation type" className="mt-1 block w-full rounded border p-2" value={values.type} onChange={(e) => setValues({ ...values, type: e.target.value as typeof values.type })}>
        <option value="">Unspecified</option><option value="free">Free cancellation</option><option value="partial_refund">Partial refund</option></select></label>
      <p className="text-sm">After-deadline and no-show penalty: full booking amount.</p>
      {field("window", "Partial-refund window (optional, 1–365 days)")}{field("percent", "Partial-refund amount (optional, 1–99%)")}
      <p className="text-sm">Refund tiers: days before check-in and percentage refunded. Up to ten; each deadline must be different.</p>
      {tiers.map((tier, i) => <div key={i} className="flex flex-wrap items-end gap-2">
        {(["days", "percent"] as const).map((key) => <label key={key} className="text-sm">{key === "days" ? "At least this many days" : "Refund %"}<input aria-label={`Tier ${i + 1} ${key}`} inputMode="numeric" value={tier[key]} className="mt-1 block w-32 rounded border p-2" onChange={(e) => setTiers(tiers.map((t, j) => j === i ? { ...t, [key]: e.target.value } : t))} /></label>)}
        <button type="button" className="rounded border px-3 py-2" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove tier {i + 1}</button>
      </div>)}
      <button type="button" disabled={disabled || tiers.length >= 10} className="rounded border px-3 py-2 disabled:opacity-50" onClick={() => setTiers([...tiers, { days: "", percent: "" }])}>Add refund tier</button>
      <label className="block text-sm">Cancellation policy text<textarea aria-label="Cancellation policy text" className="mt-1 block w-full rounded border p-2" rows={3} value={values.text} onChange={(e) => setValues({ ...values, text: e.target.value })} /></label>
      <p className="text-xs text-gray-600">Switching to non-refundable removes flexible policy fields when applied.</p>
    </>}
    <label className="block text-sm">Requested payment schedule<select aria-label="Requested payment schedule" className="mt-1 block w-full rounded border p-2" value={payment} onChange={(e) => setPayment(e.target.value as typeof payment)}>
      <option value="full">Full payment</option><option value="deposit">Deposit and balance</option></select></label>
    {payment === "deposit" && <>{field("deposit", "Deposit (% of final total)")}{field("balance", "Balance due (days before arrival)")}
      <p className="text-sm text-amber-900">Deposit execution is not available yet. This requested schedule cannot be approved until payment readiness supports it.</p></>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <p className="text-sm">Apply changes locally, then save and review your pricing draft. Approved policies change only when rates are approved.</p>
    <div className="flex gap-2"><button type="button" className="rounded bg-emerald-700 px-3 py-2 text-white" onClick={apply}>Apply policy changes</button>
      <button type="button" className="rounded border px-3 py-2" onClick={onCancel}>Cancel policy changes</button></div>
  </fieldset>;
}
