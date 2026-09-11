"use client";
import { useEffect, useRef, useState } from "react";
import type {
  FinancePaymentReadinessSnapshot,
  FinancePaymentReadinessBlocker,
} from "@vayada/domain-finance";
import { financePaymentReadinessClient as client } from "@/services/api/financePaymentReadinessClient";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  AdaptiveStepSkeleton,
  adaptivePrimaryButtonClass,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import { adaptiveStepErrorMessage } from "../adaptiveSetupStepState";
import { useFinalStepDraft } from "./useFinalStepDraft";
import { StripeSetupControls } from "./StripeSetupControls";

type Method = "pay_at_property" | "card";
const methods = [
  {
    method: "pay_at_property",
    field: "pay_at_hotel",
    label: "Pay at hotel",
    description:
      "Guests pay at your property. No online payment account or bank details are required.",
  },
  {
    method: "card",
    field: "online_card",
    label: "Online card",
    description:
      "Guests pay online. Connecting Stripe is one requirement; verified card payment execution must also be ready.",
  },
] as const;
const blockerCopy: Record<FinancePaymentReadinessBlocker, string> = {
  payment_settings_uncommitted: "Save your payment selection.",
  pricing_currency_unavailable:
    "Set your property currency in Pricing before saving payment methods.",
  pricing_currency_mismatch: "Your property currency changed. Refresh and review this selection.",
  online_card_execution_unavailable:
    "Online card payments are waiting for verified payment execution.",
  online_card_currency_unsupported: "Online cards do not support the property's current currency.",
  provider_restricted:
    "Stripe has restricted this account. Review your Stripe account requirements.",
  provider_capability_lost:
    "Stripe card capability is unavailable. Review your Stripe account requirements.",
  bank_transfer_contract_unavailable: "Bank transfer is not available for setup.",
};
export function PaymentsStep(props: AdaptiveSetupStepComponentProps) {
  const draft = useFinalStepDraft(props, "payments");
  const canonical = useRef<FinancePaymentReadinessSnapshot | null>(null);
  const savedHere = useRef(false);
  const [snapshot, setSnapshot] = useState<FinancePaymentReadinessSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const { initialize } = draft;
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setLoadError(null);
    void client
      .load(props.propertyId, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (controller.signal.aborted) return;
        canonical.current = value;
        savedHere.current = false;
        setSnapshot(value);
        initialize({
          "payment.accepted_methods": methods
            .filter(({ method }) =>
              value.methods.some((item) => item.method === method && item.selected),
            )
            .map(({ field }) => field),
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(adaptiveStepErrorMessage(error));
      });
    return () => controller.abort();
  }, [props.propertyId, initialize, draft.reload, retry]);
  function selected(): Method[] {
    const fields = draft.values.current["payment.accepted_methods"];
    return methods
      .filter(({ field }) => Array.isArray(fields) && fields.includes(field))
      .map(({ method }) => method);
  }
  const fields = draft.data["payment.accepted_methods"];
  const selection = methods
    .filter(({ field }) => Array.isArray(fields) && fields.includes(field))
    .map(({ method }) => method);
  const matchesSaved =
    !!snapshot &&
    methods.every(({ method }) =>
      snapshot.methods.some(
        (item) => item.method === method && item.selected === selection.includes(method),
      ),
    );
  async function save(advance: boolean) {
    setNotice("");
    await draft.commit(async () => {
      const current = canonical.current;
      if (!current || !selected().length) throw new Error("Choose at least one payment method.");
      const base = draft.revision.current.baseRevisions;
      if (
        !savedHere.current &&
        (base?.["finance.payment_methods"] !==
          `payment-methods:${current.paymentMethodsRevision}` ||
          base?.["pms.pricing_settings"] !==
            `pricing:${current.pricingCurrency.current?.pricingCurrencyRevision ?? 0}`)
      ) {
        props.reportRevisionConflict();
        throw new Error("Payment settings or currency changed. Refresh before saving.");
      }
      const same = methods.every(({ method }) =>
        current.methods.some(
          (item) => item.method === method && item.selected === selected().includes(method),
        ),
      );
      const value =
        same && current.pricingCurrency.matchesCurrent
          ? current
          : await client.save(props.propertyId, {
              expectedPaymentMethodsRevision: current.paymentMethodsRevision,
              expectedPricingCurrencyRevision:
                current.pricingCurrency.current?.pricingCurrencyRevision ?? 0,
              selectedMethods: selected(),
            });
      canonical.current = value;
      savedHere.current = true;
      setSnapshot(value);
      setNotice(
        value.bookingPaymentReady
          ? "Payment selection saved."
          : "Payment selection saved. No selected method is ready yet.",
      );
      if (advance && !value.bookingPaymentReady)
        throw new Error("Select and save a ready payment method before continuing.");
    }, advance);
  }
  if (loadError)
    return <AdaptiveSaveError message={loadError} onRetry={() => setRetry((value) => value + 1)} />;
  if (!snapshot) return <AdaptiveStepSkeleton columns />;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {draft.error && <AdaptiveSaveError message={draft.error} />}
      {notice && (
        <p role="status" className="rounded-lg bg-gray-50 p-4 text-sm">
          {notice}
        </p>
      )}
      <p className="text-sm text-gray-600">
        Property currency:{" "}
        <strong>{snapshot.pricingCurrency.current?.currency ?? "Not configured"}</strong>. Manage
        currency in Pricing.
      </p>
      {!snapshot.pricingCurrency.current && (
        <p role="status" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          Set your property currency in Pricing before saving payment methods. Your selection can be
          saved as a draft when you exit.
        </p>
      )}
      <fieldset disabled={draft.saving} className="grid gap-6 md:grid-cols-2">
        <legend className="sr-only">Payment methods</legend>
        {methods.map(({ method, label, description }) => {
          const status = snapshot.methods.find((item) => item.method === method)!;
          const checked = selection.includes(method);
          return (
            <AdaptiveStepCard key={method}>
              <label className="flex items-center gap-3 text-lg font-semibold">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const fields = methods
                      .filter((item) =>
                        item.method === method ? !checked : selection.includes(item.method),
                      )
                      .map((item) => item.field);
                    draft.change("payment.accepted_methods", fields);
                    savedHere.current = false;
                    setNotice("");
                  }}
                />
                {label}
              </label>
              <p className="mt-3 text-sm text-gray-600">{description}</p>
              <p className="mt-4 text-sm font-semibold">
                {!checked
                  ? "Not selected"
                  : !status.selected || !matchesSaved
                    ? "Selection not saved"
                    : status.readiness === "ready"
                      ? "Ready"
                      : "Saved · pending"}
              </p>
              {checked && status.selected && status.blockers.length > 0 && (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-amber-900">
                  {status.blockers.map((code) => (
                    <li key={code}>{blockerCopy[code]}</li>
                  ))}
                </ul>
              )}
            </AdaptiveStepCard>
          );
        })}
      </fieldset>
      <StripeSetupControls
        organizationId={props.route.scope.organizationId}
        visible={selection.includes("card")}
        propertyId={props.propertyId}
        enabled={matchesSaved && !draft.saving}
        onReadiness={(value) => {
          const current = canonical.current;
          if (
            current &&
            (value.paymentMethodsRevision < current.paymentMethodsRevision ||
              (value.pricingCurrency.current &&
                current.pricingCurrency.current &&
                value.pricingCurrency.current.pricingCurrencyRevision <
                  current.pricingCurrency.current.pricingCurrencyRevision))
          )
            return;
          if (
            current &&
            (value.paymentMethodsRevision !== current.paymentMethodsRevision ||
              value.pricingCurrency.current?.pricingCurrencyRevision !==
                current.pricingCurrency.current?.pricingCurrencyRevision)
          )
            savedHere.current = false;
          canonical.current = value;
          setSnapshot(value);
        }}
      />
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          className={adaptiveSecondaryButtonClass}
          disabled={draft.saving || !selection.length || !snapshot.pricingCurrency.current}
          onClick={() => void save(false)}
        >
          {draft.saving ? "Saving…" : "Save selection"}
        </button>
        <button
          type="button"
          className={adaptivePrimaryButtonClass}
          disabled={draft.saving || !matchesSaved || !snapshot.bookingPaymentReady}
          onClick={() => void save(true)}
        >
          Save and continue
        </button>
      </div>
    </div>
  );
}
