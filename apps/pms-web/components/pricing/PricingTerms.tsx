"use client";

import { useEffect, useState } from "react";
import type { ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { PricingPolicyForm } from "./PricingPolicyForm";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { ApiErrorResponse } from "@/services/api/client";
import { useTranslation } from "@/lib/i18n";
import type { MessageKey } from "./pricingAmounts";

type Reference = { propertyId: string; client: ReturnType<typeof createReplacementPricingClient>; roomTypeId: string; offerId: string; revision: string; savedDraft?: { draftId: string; revision: number }; local?: PricingTermsInput; verified?: ReplacementOfferTerms; disabled?: boolean; blocked?: boolean; expanded?: boolean; onApply?(terms: ReplacementOfferTerms): void; onPending?(pending: boolean): void };
// A new reference gets a new component: old policy data never flashes under a different offer.
export function PricingTerms(props: Reference) {
  return <Terms key={`${props.propertyId}:${props.roomTypeId}:${props.offerId}:${props.revision}:${props.savedDraft?.draftId ?? ""}:${props.savedDraft?.revision ?? ""}:${JSON.stringify(props.local)}:${!!props.verified}`} {...props} />;
}
function Terms({ client, roomTypeId, offerId, revision, savedDraft, local, verified, disabled = false, blocked = false, expanded = false, onApply, onPending }: Reference) {
  const [open, setOpen] = useState(expanded || !!local), [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [terms, setTerms] = useState<ReplacementOfferTerms | null>(null), [error, setError] = useState<MessageKey | "">("");
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    if (verified) { setTerms(verified); setError(""); setLoading(false); return; }
    if (local) { setTerms({ roomTypeId, offerId, revision, cancellation: local.cancellation, payment: local.payment }); setError(""); setLoading(false); return; }
    let active = true;
    setLoading(true); setTerms(null); setError("");
    void (savedDraft ? client.readTerms(roomTypeId, offerId, revision, savedDraft) : client.readTerms(roomTypeId, offerId, revision)).then((value) => {
      if (!active) return;
      if (value) setTerms(value); else setError("pricing.terms.notFound");
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof ApiErrorResponse && cause.status === 403 ? "pricing.terms.forbidden"
        : cause instanceof ApiErrorResponse && cause.status === 409 ? "pricing.terms.changed"
        : "pricing.terms.loadFailed");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, attempt, client, roomTypeId, offerId, revision, savedDraft, local, verified]);
  return <div className="mt-3 border-t pt-3">
    {!open ? <button type="button" className="font-medium text-emerald-800 underline" onClick={() => setOpen(true)}>{t("pricing.terms.show")}</button> : <>
      <h4 className="font-medium text-gray-900">{t("pricing.terms.title")}</h4>
      {loading && <p role="status">{t("pricing.terms.loading")}</p>}
      {error && <div role="alert"><p>{t(error)}</p><button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>{t("pricing.terms.retry")}</button></div>}
      {terms && <><Policy terms={terms} />{local && <p className="text-sm text-amber-900">{t("pricing.terms.unsaved")}</p>}
        {onApply && (editing ? <PricingPolicyForm terms={terms} disabled={disabled} onCancel={() => { setEditing(false); onPending?.(false); }}
          onApply={(next) => { onApply(next); setEditing(false); onPending?.(false); }} /> :
          <button type="button" disabled={disabled || blocked} className="mt-2 rounded border px-3 py-2 disabled:opacity-50" onClick={() => { if (!disabled && !blocked) { setEditing(true); onPending?.(true); } }}>{t("pricing.policy.title")}</button>)}</>}
    </>}
  </div>;
}
function Policy({ terms }: { terms: ReplacementOfferTerms }) {
  const cancellation = terms.cancellation, payment = terms.payment;
  const { t } = useTranslation();
  return <div className="mt-2 space-y-1">
    {cancellation.kind === "non_refundable" ? <p>{t("pricing.terms.nonRefundable")}</p> : <>
      <p>{t(cancellation.terms.flexibleCancellationType === "partial_refund" ? "pricing.terms.partialRefund" : "pricing.terms.flexible")}</p>
      <p>{t("pricing.terms.deadline", { days: cancellation.terms.freeCancellationDeadlineDays })}</p>
      <p>{t("pricing.policy.penalty")}</p>
      {cancellation.terms.partialRefundCancelWindowDays !== undefined && <p>{t("pricing.terms.window", { days: cancellation.terms.partialRefundCancelWindowDays })}</p>}
      {cancellation.terms.partialRefundAmountPercent !== undefined && <p>{t("pricing.terms.percent", { percent: cancellation.terms.partialRefundAmountPercent })}</p>}
      {cancellation.terms.partialRefundTiers?.map((tier) => <p key={tier.minDaysBeforeCheckIn}>{t("pricing.terms.tier", { days: tier.minDaysBeforeCheckIn, percent: tier.refundPercent })}</p>)}
      {cancellation.terms.text && <p className="whitespace-pre-wrap">{cancellation.terms.text}</p>}
    </>}
    {payment.kind === "full" ? <p>{t("pricing.terms.full")}</p> : <>
      <p>{t("pricing.terms.deposit", { percent: payment.basisPoints / 100, days: payment.balanceDaysBeforeArrival })}</p>
      <p>{t("pricing.terms.depositNote")}</p>
    </>}
    {payment.acceptedMethods?.length ? <p>{t("pricing.terms.methods", { methods: payment.acceptedMethods.map((method) => t(method === "card" ? "pricing.terms.methodCard" : "pricing.terms.methodPayAtProperty")).join(", ") })}</p>
      : <p className="text-amber-900">{t("pricing.terms.noMethods")}</p>}
    <p className="text-xs text-gray-500">{t("pricing.terms.footer")}</p>
  </div>;
}
