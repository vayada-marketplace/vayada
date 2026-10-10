import { ApiErrorResponse } from "@/services/api/client";
import { samePricingValue, type createReplacementPricingClient, type PricingSnapshot, type PricingDraft, type PricingChargeReview, type PricingTermsInput } from "@/services/api/replacementPricingClient";

import { errorText, type MessageKey, type Translate } from "./pricingAmounts";

type Client = ReturnType<typeof createReplacementPricingClient>;

/** One "Save prices" press for the whole property: stage edited terms, prepare, save the draft, read its server
 * charge fingerprint, declare (the press is the mandatory-charges declaration), attach and publish. `snapshot`
 * holds every room at `baseRevision + 1`; the server refuses the publish (409) after another publication or a
 * room, terms or payment change since `baseRevision`. Calling the returned step again after a failure resumes
 * with the same idempotency keys; each press creates a new step and so a fresh draft. */
export function pricingSave(client: Client, input: { snapshot: PricingSnapshot; baseRevision: number; terms: readonly PricingTermsInput[] }) {
  const { snapshot: edited, baseRevision } = input;
  const id = crypto.randomUUID(), selected = { draftId: id, baseRevision };
  const stages = input.terms.map((terms) => ({ input: terms, action: client.termsAction(terms, selected), saved: null as Awaited<ReturnType<ReturnType<Client["termsAction"]>>> | null }));
  let prepared: Awaited<ReturnType<Client["prepare"]>> | null = null, saved: PricingDraft | null = null, reviewed: PricingChargeReview | null = null;
  let confirm: ReturnType<Client["confirmationAction"]> | null = null, confirmed: Awaited<ReturnType<ReturnType<Client["confirmationAction"]>>> | null = null;
  let attached: PricingDraft | null = null, publish: ReturnType<Client["publicationAction"]> | null = null;
  return async (): Promise<PricingDraft> => {
    for (const stage of stages) stage.saved ??= await stage.action();
    const rooms = edited.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => {
      const stage = stages.find((s) => s.input.roomTypeId === r.roomTypeId && s.input.offerId === o.id);
      return stage ? { ...o, termsRevision: stage.saved!.revision } : o;
    }) }));
    prepared ??= await client.prepare({ currency: edited.currency, rooms }, selected);
    if (!saved) saved = { draftId: id, revision: await client.saveDraft({ draftId: id, expectedDraftRevision: 0, baseRevision, ...prepared }), baseRevision, ...prepared, stale: false };
    if (!reviewed) {
      const next = await client.reviewCharges(id);
      // Declare only for exactly what this action saved; another save in between means start again.
      if (!next || next.revision !== saved.revision || !samePricingValue(next.snapshot, saved.snapshot)) throw new ApiErrorResponse(409, { message: "The saved prices changed. Reload pricing." });
      reviewed = next;
    }
    confirm ??= client.confirmationAction(reviewed, "save_prices");
    confirmed ??= await confirm();
    if (!attached) {
      const snapshot = { ...reviewed.snapshot, ownerReferences: { ...reviewed.snapshot.ownerReferences, charges: confirmed.id } };
      const evidence = { baseRevision: reviewed.baseRevision, sources: reviewed.sources, ...(reviewed.effectiveSources ? { effectiveSources: reviewed.effectiveSources } : {}), snapshot };
      attached = { draftId: reviewed.draftId, ...evidence, revision: await client.saveDraft({ draftId: reviewed.draftId, expectedDraftRevision: reviewed.revision, ...evidence }), stale: false };
    }
    publish ??= client.publicationAction(attached);
    await publish();
    return attached;
  };
}

const financeReasons = {
  settings_missing: "pricing.editor.financeSettingsMissing",
  payments_disabled: "pricing.editor.financePaymentsDisabled",
  currency_mismatch: "pricing.editor.financeCurrencyMismatch",
  method_unavailable: "pricing.editor.financeMethodUnavailable",
  deposit_execution_unavailable: "pricing.editor.financeDepositUnavailable",
} as const satisfies Record<string, MessageKey>;
/** Prepare's denial when Finance is not ready: fixable in payment settings without losing edits. */
function financeReason(error: unknown) {
  const reason = error instanceof ApiErrorResponse && error.status === 403 ? (error.data as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" && Object.hasOwn(financeReasons, reason) ? financeReasons[reason as keyof typeof financeReasons] : null;
}
export const financeNotReady = (error: unknown) => financeReason(error) !== null;
export function pricingSaveError(error: unknown, t: Translate) {
  const finance = financeReason(error);
  if (finance) return t(finance);
  if (error instanceof ApiErrorResponse && error.status === 409) return t("pricing.editor.errorChanged");
  if (error instanceof ApiErrorResponse && error.status === 403) return t("pricing.editor.errorForbidden");
  return errorText(error, t, "pricing.editor.errorSaveFailed");
}
