"use client";

import { useEffect, useState } from "react";
import type { ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
import { PricingPolicyForm } from "./PricingPolicyForm";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { ApiErrorResponse } from "@/services/api/client";

type Reference = { propertyId: string; client: ReturnType<typeof createReplacementPricingClient>; roomTypeId: string; offerId: string; revision: string; savedDraft?: { draftId: string; revision: number }; local?: PricingTermsInput; verified?: ReplacementOfferTerms; disabled?: boolean; blocked?: boolean; expanded?: boolean; onApply?(terms: ReplacementOfferTerms): void; onPending?(pending: boolean): void };
// A new reference gets a new component: old policy data never flashes under a different offer.
export function PricingTerms(props: Reference) {
  return <Terms key={`${props.propertyId}:${props.roomTypeId}:${props.offerId}:${props.revision}:${props.savedDraft?.draftId ?? ""}:${props.savedDraft?.revision ?? ""}:${JSON.stringify(props.local)}:${!!props.verified}`} {...props} />;
}
function Terms({ client, roomTypeId, offerId, revision, savedDraft, local, verified, disabled = false, blocked = false, expanded = false, onApply, onPending }: Reference) {
  const [open, setOpen] = useState(expanded || !!local), [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [terms, setTerms] = useState<ReplacementOfferTerms | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (verified) { setTerms(verified); setError(""); setLoading(false); return; }
    if (local) { setTerms({ roomTypeId, offerId, revision, cancellation: local.cancellation, payment: local.payment }); setError(""); setLoading(false); return; }
    let active = true;
    setLoading(true); setTerms(null); setError("");
    void (savedDraft ? client.readTerms(roomTypeId, offerId, revision, savedDraft) : client.readTerms(roomTypeId, offerId, revision)).then((value) => {
      if (!active) return;
      if (value) setTerms(value); else setError("No saved terms were found for this offer.");
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof ApiErrorResponse && cause.status === 403 ? "You do not have access to these terms."
        : cause instanceof ApiErrorResponse && cause.status === 409 ? "These terms changed. Reload pricing before reviewing this offer."
        : "The saved terms could not be verified. Try loading them again.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, attempt, client, roomTypeId, offerId, revision, savedDraft, local, verified]);
  return <div className="mt-3 border-t pt-3">
    {!open ? <button type="button" className="font-medium text-emerald-800 underline" onClick={() => setOpen(true)}>Show cancellation and payment terms</button> : <>
      <h4 className="font-medium text-gray-900">Cancellation and payment terms</h4>
      {loading && <p role="status">Loading saved terms…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>Retry policy load</button></div>}
      {terms && <><Policy terms={terms} />{local && <p className="text-sm text-amber-900">Unsaved policy changes</p>}
        {onApply && (editing ? <PricingPolicyForm terms={terms} disabled={disabled} onCancel={() => { setEditing(false); onPending?.(false); }}
          onApply={(next) => { onApply(next); setEditing(false); onPending?.(false); }} /> :
          <button type="button" disabled={disabled || blocked} className="mt-2 rounded border px-3 py-2 disabled:opacity-50" onClick={() => { if (!disabled && !blocked) { setEditing(true); onPending?.(true); } }}>Edit cancellation and payment</button>)}</>}
    </>}
  </div>;
}
function Policy({ terms }: { terms: ReplacementOfferTerms }) {
  const cancellation = terms.cancellation, payment = terms.payment;
  return <div className="mt-2 space-y-1">
    {cancellation.kind === "non_refundable" ? <p>Non-refundable.</p> : <>
      <p>{cancellation.terms.flexibleCancellationType === "partial_refund" ? "Partial-refund cancellation policy." : "Flexible cancellation policy."}</p>
      <p>Saved cancellation deadline: {cancellation.terms.freeCancellationDeadlineDays} days before arrival.</p>
      <p>After-deadline and no-show penalty: full booking amount.</p>
      {cancellation.terms.partialRefundCancelWindowDays !== undefined && <p>Partial-refund cancellation window: {cancellation.terms.partialRefundCancelWindowDays} days before arrival.</p>}
      {cancellation.terms.partialRefundAmountPercent !== undefined && <p>Partial-refund amount setting: {cancellation.terms.partialRefundAmountPercent}%.</p>}
      {cancellation.terms.partialRefundTiers?.map((tier) => <p key={tier.minDaysBeforeCheckIn}>At least {tier.minDaysBeforeCheckIn} days before check-in: {tier.refundPercent}% refund.</p>)}
      {cancellation.terms.text && <p className="whitespace-pre-wrap">{cancellation.terms.text}</p>}
    </>}
    {payment.kind === "full" ? <p>Payment in full.</p> : <>
      <p>Deposit: {payment.basisPoints / 100}% of the final total. Balance due {payment.balanceDaysBeforeArrival} days before arrival.</p>
      <p>Deposit collection is not enabled by displaying this policy.</p>
    </>}
    <p className="text-xs text-gray-500">Policy settings only; this does not calculate a cancellation refund.</p>
  </div>;
}
