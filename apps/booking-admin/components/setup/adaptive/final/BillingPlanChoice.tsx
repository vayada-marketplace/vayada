"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorResponse } from "@/services/api/client";
import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  type FinancePlanStatus,
} from "@/services/api/hotelOperationsSetupClient";
import { PlanCard } from "./BillingPlanCard";
import { AdaptiveStepCard, adaptiveSecondaryButtonClass } from "../AdaptiveStepPrimitives";

/** Setup can continue once a plan is chosen, or while its Fixed Fee checkout runs in Stripe. */
export function isBillingPlanSettled(status: FinancePlanStatus | null): boolean {
  return Boolean(status && (status.plan || status.checkoutPending));
}

function fixedPlanPrice(status: FinancePlanStatus): string {
  if (!status.fixedPlanAvailable) return "Not available";
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: status.currency,
    maximumFractionDigits: 0,
  }).format(status.amountMinor / 100);
  return `${amount} / 30 days`;
}

/**
 * "Your vayada plan" in the Payments step (VAY-2171). Commission is pre-selected and the hotel
 * confirms it; Fixed Fee opens the existing Stripe Checkout. Nothing is chosen on its own.
 */
export function BillingPlanChoice({
  propertyId,
  disabled,
  onStatus,
  onChanged,
}: {
  propertyId: string;
  disabled: boolean;
  /** The current plan status; null while it loads or after it failed to load. */
  onStatus: (status: FinancePlanStatus | null) => void;
  /** After the hotel changed its plan here, so the setup route can refresh the step state. */
  onChanged: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<FinancePlanStatus | null>(null);
  const [selection, setSelection] = useState<"commission" | "fixed">("commission");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intentRevision] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const report = useRef(onStatus);
  // The plan is saved by then; a failed step refresh only leaves the step state stale.
  const changed = () => Promise.resolve(onChanged()).catch(() => undefined);
  useEffect(() => {
    report.current = onStatus;
  }, [onStatus]);
  const show = useCallback((next: FinancePlanStatus | null) => {
    setStatus(next);
    report.current(next);
  }, []);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoadError("");
      try {
        const loaded = await hotelOperationsSetupApi.getPlanStatus(propertyId, signal);
        if (signal?.aborted) return null;
        setSelection(loaded.checkoutPending ? "fixed" : "commission");
        show(loaded);
        return loaded;
      } catch (cause) {
        if (!signal?.aborted)
          setLoadError(planErrorMessage(cause, "Your vayada plan could not be loaded."));
        return null;
      }
    },
    [propertyId, show],
  );
  useEffect(() => {
    const controller = new AbortController();
    show(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reload, show]);

  const confirm = async () => {
    if (!status || busy) return;
    // Opened before any await, or the browser blocks it as a pop-up.
    const checkoutWindow = selection === "fixed" ? window.open("", "vayada-fixed-plan") : null;
    if (selection === "fixed" && !checkoutWindow) {
      setError("Allow pop-ups for vayada, then try opening Stripe Checkout again.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    let saved = false;
    try {
      if (selection === "commission") {
        show(await hotelOperationsSetupApi.selectCommissionPlan(propertyId, intentRevision));
        setNotice("Commission plan confirmed. You pay 5% per direct booking.");
      } else {
        const checkout = await hotelOperationsSetupApi.startFixedPlanCheckout(
          propertyId,
          intentRevision,
        );
        checkoutWindow!.location.assign(checkout.checkoutUrl);
        show({ ...status, status: "checkout_pending", checkoutPending: true });
        setNotice("Stripe Checkout opened in a new tab. Finish it there, then select Check again.");
      }
      saved = true;
    } catch (cause) {
      checkoutWindow?.close();
      setError(planErrorMessage(cause, "Your vayada plan could not be saved."));
    } finally {
      setBusy(false);
    }
    if (saved) await changed();
  };
  const checkAgain = async () => {
    setBusy(true);
    setNotice("");
    try {
      if ((await load())?.plan) await changed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdaptiveStepCard>
      <h2 className="text-lg font-semibold">Your vayada plan</h2>
      <p className="mt-1 text-sm text-gray-600">
        How you pay vayada for direct bookings. Choose one to start taking bookings.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-gray-700">
          {notice}
        </p>
      )}
      {loadError ? (
        <>
          <p role="alert" className="mt-4 text-sm text-red-800">
            {loadError}
          </p>
          <button
            type="button"
            className={`mt-3 ${adaptiveSecondaryButtonClass}`}
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </button>
        </>
      ) : !status ? (
        <p className="mt-4 text-sm text-gray-500">Loading your plan…</p>
      ) : status.plan ? (
        <>
          <p className="mt-4 text-sm font-semibold text-gray-950">
            Your plan:{" "}
            {status.plan === "commission"
              ? "Commission · 5% per direct booking"
              : `Fixed Fee · ${fixedPlanPrice(status)}`}
          </p>
          <p className="mt-2 text-sm text-gray-600">Change it anytime in Settings → Billing.</p>
        </>
      ) : (
        <>
          <fieldset disabled={disabled || busy} className="mt-4 grid gap-4 md:grid-cols-2">
            <legend className="sr-only">Your vayada plan</legend>
            <PlanCard
              badge="Recommended"
              checked={selection === "commission"}
              description="No monthly fee. Pay only when you earn."
              label="Commission"
              onChange={() => setSelection("commission")}
              price="5% per direct booking"
            />
            <PlanCard
              checked={selection === "fixed"}
              description="Flat 30-day subscription. No per-booking fee."
              disabled={!status.fixedPlanAvailable}
              label="Fixed Fee"
              onChange={() => setSelection("fixed")}
              price={fixedPlanPrice(status)}
              secondary={
                !status.fixedPlanAvailable
                  ? `Not available in ${status.currency} yet.`
                  : status.currency === "EUR"
                    ? "€30 first active room + €5 each additional room"
                    : undefined
              }
            />
          </fieldset>
          <p className="mt-3 text-sm text-gray-600">
            You can switch plans anytime in Settings → Billing.
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            {status.checkoutPending && (
              <button
                type="button"
                disabled={disabled || busy}
                className={adaptiveSecondaryButtonClass}
                onClick={() => void checkAgain()}
              >
                Check again
              </button>
            )}
            <button
              type="button"
              disabled={disabled || busy}
              className={adaptiveSecondaryButtonClass}
              onClick={() => void confirm()}
            >
              {busy
                ? "Saving plan…"
                : selection === "commission"
                  ? "Confirm Commission plan"
                  : "Continue to Stripe Checkout"}
            </button>
          </div>
        </>
      )}
    </AdaptiveStepCard>
  );
}

function planErrorMessage(cause: unknown, fallback: string): string {
  // Like the hotel currency, the plan is the owner's (or finance manager's) to choose.
  return cause instanceof ApiErrorResponse && cause.status === 403
    ? "Your role can't choose the vayada plan. Ask the hotel owner to finish this step."
    : hotelOperationsErrorMessage(cause, fallback);
}
