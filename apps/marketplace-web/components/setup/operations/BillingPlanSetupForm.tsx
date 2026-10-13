"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  type FinancePlanStatus,
} from "@/services/api/hotelOperationsSetupClient";

import { PlanCard } from "./BillingPlanCard";
import {
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
} from "./OperationFormShell";

type BillingPlan = "commission" | "fixed";

export function BillingPlanSetupForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
  taskComplete,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
  taskComplete: boolean;
}) {
  const [status, setStatus] = useState<FinancePlanStatus | null>(null);
  const [selection, setSelection] = useState<BillingPlan>("commission");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [intentRevision] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void hotelOperationsSetupApi
      .getPlanStatus(propertyId, controller.signal)
      .then((loaded) => {
        setStatus(loaded);
        setSelection(loaded.plan === "fixed" || loaded.checkoutPending ? "fixed" : "commission");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(
            hotelOperationsErrorMessage(cause, "Your billing plan could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [propertyId, reloadToken]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status) return;
    const checkoutWindow =
      selection === "fixed" && status.plan !== "fixed"
        ? window.open("", "vayada-fixed-plan")
        : null;
    if (selection === "fixed" && status.plan !== "fixed" && !checkoutWindow) {
      setError("Allow pop-ups for vayada, then try opening Stripe Checkout again.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onBeforeSave();
      if (selection === "commission") {
        if (!taskComplete || status.checkoutPending) {
          await hotelOperationsSetupApi.selectCommissionPlan(propertyId, intentRevision);
        }
      } else if (status.plan !== "fixed") {
        const checkout = await hotelOperationsSetupApi.startFixedPlanCheckout(
          propertyId,
          intentRevision,
        );
        checkoutWindow!.location.assign(checkout.checkoutUrl);
      }
      await onCompleted();
    } catch (cause) {
      checkoutWindow?.close();
      setError(hotelOperationsErrorMessage(cause, "Your billing plan could not be saved."));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <OperationFormLoading />;
  if (loadError || !status) {
    return (
      <OperationFormLoadError
        message={loadError || "Your billing plan could not be loaded."}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  const fixedAmount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: status.currency,
    maximumFractionDigits: 0,
  }).format(status.amountMinor / 100);

  return (
    <OperationFormShell
      error={error}
      notice={
        selection === "fixed" && status.plan !== "fixed"
          ? "Stripe Checkout opens in a new tab. You can finish the subscription now or return to it from Settings."
          : "You can switch plans anytime from Settings → Billing."
      }
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel="Continue to payment methods"
      submitting={submitting}
      submittingLabel="Saving plan…"
    >
      <fieldset className="space-y-4 sm:col-span-2">
        <legend className="sr-only">How you pay for vayada</legend>
        <p className="text-sm text-gray-600">How you pay for vayada.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <PlanCard
            badge="Recommended"
            checked={selection === "commission"}
            description="No monthly fee. Pay only when you earn."
            disabled={status.plan === "fixed"}
            label="Commission"
            onChange={() => setSelection("commission")}
            price="5% per direct booking"
          />
          <PlanCard
            checked={selection === "fixed"}
            description="Flat 30-day subscription. No per-booking fee."
            disabled={status.plan === "fixed" && status.status === "cancel_at_period_end"}
            label="Fixed Fee"
            onChange={() => setSelection("fixed")}
            price={`${fixedAmount} / 30 days`}
            secondary="€30 first active room + €5 each additional room"
          />
        </div>
      </fieldset>
    </OperationFormShell>
  );
}
