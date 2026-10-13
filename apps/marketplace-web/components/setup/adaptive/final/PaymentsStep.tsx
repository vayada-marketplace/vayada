"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FinancePaymentReadinessSnapshot,
  FinancePaymentReadinessBlocker,
} from "@vayada/domain-finance";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import { ApiErrorResponse } from "@/services/api/client";
import {
  getAuthCsrfToken,
  getAuthOrganizationId,
  getAuthWorkosOrganizationId,
} from "@/services/auth/sessionStore";
import { productHandoffReturnTo } from "../../productHandoffReturnTo";
import {
  financePaymentReadinessClient as client,
  type ManualPaymentMethods,
} from "@/services/api/financePaymentReadinessClient";
import {
  onboardingPricingApi,
  type OnboardingPricingOwners,
} from "@/services/api/onboardingPricingClient";
import type { FinancePlanStatus } from "@/services/api/hotelOperationsSetupClient";
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
import { BillingPlanChoice, isBillingPlanSettled } from "./BillingPlanChoice";

type Method = "pay_at_property" | "card";
function matchesSelection(snapshot: FinancePaymentReadinessSnapshot, desired: Method[]) {
  const stored = snapshot.methods.filter((item) => item.selected).map((item) => item.method);
  return stored.length === desired.length && desired.every((method) => stored.includes(method));
}
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
/** Bank transfer and PayPal are set up in Booking Engine settings for now (VAY-2139). */
const BOOKING_ADMIN_URL = (
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com"
).replace(/\/$/, "");
const PAYMENT_SETTINGS_PATH = "/settings/payments";
const MANUAL_OFF: ManualPaymentMethods = { acceptanceEnabled: false, readyMethods: [] };
const manualLabels = { bank_transfer: "Bank transfer", paypal: "PayPal" } as const;
const blockerCopy: Record<FinancePaymentReadinessBlocker, string> = {
  payment_settings_uncommitted: "Save your payment selection.",
  pricing_currency_unavailable: "Choose the hotel currency before saving payment methods.",
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
/** The hotel's one pricing currency, saved through the PMS currency route like the Pricing step. */
function HotelCurrencyChoice({
  propertyId,
  disabled,
  onSaved,
  onNotice,
}: {
  propertyId: string;
  disabled: boolean;
  /** Reloads the step on the new currency; runs `save` first, inside the step's busy section. */
  onSaved: (save?: () => Promise<void>) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [owners, setOwners] = useState<OnboardingPricingOwners | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // A ref, not `busy`: two clicks in one frame both see the old state.
  const running = useRef(false);
  const run = useCallback(async (task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(adaptiveStepErrorMessage(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setOwners(null);
    setError(null);
    void onboardingPricingApi
      .load(propertyId, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (controller.signal.aborted) return;
        // Chosen elsewhere since Payments loaded (another tab or the PMS): adopt it.
        if (value.pricing) void run(() => onSaved());
        else setOwners(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(currencyErrorMessage(cause));
      });
    return () => controller.abort();
  }, [propertyId, retry, run, onSaved]);
  const save = (current: OnboardingPricingOwners) =>
    run(async () => {
      const existing = { currency: null as string | null };
      await onSaved(async () => {
        try {
          await onboardingPricingApi.saveCurrency(propertyId, choice, current);
        } catch (cause) {
          // The write may have landed before its re-read failed, or another session chose the
          // currency first: continue with a currency that exists now instead of a stale retry.
          const now = await onboardingPricingApi
            .load(propertyId, { cache: "no-store" })
            .catch(() => null);
          if (now?.pricing) {
            existing.currency = now.pricing.pricingCurrency.currency;
            return;
          }
          if (now) setOwners(now);
          throw new Error(currencyErrorMessage(cause));
        }
      });
      if (existing.currency && existing.currency !== choice)
        onNotice(`The hotel currency was already set to ${existing.currency} in another session.`);
    });
  return (
    <AdaptiveStepCard>
      <h2 className="text-lg font-semibold">Hotel currency</h2>
      <p className="mt-1 text-sm text-gray-600">
        One currency for every room, rate and payment method of this hotel. Choose it before
        choosing how guests pay.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {!owners && error ? (
        <button
          type="button"
          className={`mt-3 ${adaptiveSecondaryButtonClass}`}
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry
        </button>
      ) : (
        <div className="mt-4 flex max-w-md flex-wrap items-end gap-3">
          <label className="block grow text-sm font-semibold text-gray-900">
            Hotel currency
            <select
              value={choice}
              disabled={!owners || busy || disabled}
              onChange={(event) => setChoice(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="" disabled>
                {owners ? "Choose currency" : "Loading currencies…"}
              </option>
              {owners?.currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={adaptiveSecondaryButtonClass}
            disabled={!owners || !choice || busy || disabled}
            onClick={() => owners && void save(owners)}
          >
            {busy ? "Saving…" : "Save currency"}
          </button>
        </div>
      )}
    </AdaptiveStepCard>
  );
}

function currencyErrorMessage(cause: unknown): string {
  // The currency route is the owner's (like Pricing); the Payments step itself is not.
  return cause instanceof ApiErrorResponse && cause.status === 403
    ? "Only the hotel owner can choose the hotel currency. Ask the owner to finish this step."
    : adaptiveStepErrorMessage(cause);
}

export function PaymentsStep(props: AdaptiveSetupStepComponentProps) {
  const draft = useFinalStepDraft(props, "payments");
  const canonical = useRef<FinancePaymentReadinessSnapshot | null>(null);
  const savedHere = useRef(false);
  const [snapshot, setSnapshot] = useState<FinancePaymentReadinessSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [manual, setManual] = useState<ManualPaymentMethods>(MANUAL_OFF);
  const [manualError, setManualError] = useState<string | null>(null);
  // Bookings need a chosen plan, so the step continues only with one (VAY-2171).
  const [plan, setPlan] = useState<FinancePlanStatus | null>(null);
  const planSettled = isBillingPlanSettled(plan);
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
    void client
      .manualPaymentMethods(props.propertyId, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (!controller.signal.aborted) setManual(value);
      })
      // Unknown reads as off: the step stays as it is without bank transfer and PayPal.
      .catch(() => {
        if (!controller.signal.aborted) setManual(MANUAL_OFF);
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
  const matchesSaved = !!snapshot && matchesSelection(snapshot, selection);
  // A hotel paid only by bank transfer or PayPal selects neither method here (VAY-2139). It can
  // save that empty choice, and continue once the server counts its bank transfer or PayPal.
  const manualReady = manual.acceptanceEnabled && manual.readyMethods.length > 0;
  // The server also blocks the step on the plan alone; a started Fixed checkout may continue.
  const paymentsDone =
    props.step.state === "complete" ||
    (props.step.state === "blocked" &&
      props.step.blockers.every(({ code }) => code === "billing_plan_not_selected"));
  const manualContinue =
    manualReady &&
    !selection.length &&
    !snapshot?.methods.some((item) => item.selected) &&
    paymentsDone;
  async function continueWithManual() {
    setNotice("");
    await draft.commit(async () => {
      if (!manualContinue)
        throw new Error("Add your bank details or PayPal email in Booking Engine settings first.");
    }, true);
  }
  async function openPaymentSettings() {
    setManualError(null);
    try {
      // Unsaved choices wait in the setup draft while the hotel is in Booking Engine settings.
      await draft.persist();
    } catch (cause) {
      setManualError(adaptiveStepErrorMessage(cause));
      return;
    }
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.assign(
          await createBrowserAuthHandoff({
            csrfToken,
            routingHints: { propertyId: props.propertyId },
            sourceSurface: "marketplace-web",
            targetPath: PAYMENT_SETTINGS_PATH,
            targetSurface: "booking-admin",
          }),
        );
        return;
      } catch {
        // A failed handoff falls back to Booking Engine's own sign-in.
      }
    }
    try {
      // Sign in again, then land on this hotel's payment settings.
      window.location.assign(
        crossAppReauthenticationUrl(
          BOOKING_ADMIN_URL,
          productHandoffReturnTo(PAYMENT_SETTINGS_PATH, props.propertyId, {
            organizationId: getAuthOrganizationId(),
            workosOrganizationId: getAuthWorkosOrganizationId(),
          }),
        ),
      );
    } catch {
      setManualError("We couldn't open Booking Engine settings. Please try again.");
    }
  }
  async function save(advance: boolean) {
    setNotice("");
    await draft.commit(async () => {
      const current = canonical.current;
      const none = !selected().length;
      if (!current || (none && !manualReady))
        throw new Error("Choose at least one payment method.");
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
      const same = matchesSelection(current, selected());
      const request = {
        expectedPaymentMethodsRevision: current.paymentMethodsRevision,
        expectedPricingCurrencyRevision:
          current.pricingCurrency.current?.pricingCurrencyRevision ?? 0,
        selectedMethods: selected(),
      };
      const value =
        same && current.pricingCurrency.matchesCurrent
          ? current
          : none
            ? await client.save(props.propertyId, request, { allowNoMethods: true })
            : await client.save(props.propertyId, request);
      canonical.current = value;
      savedHere.current = true;
      setSnapshot(value);
      setNotice(
        value.bookingPaymentReady
          ? "Payment selection saved."
          : none
            ? "Payment selection saved. Guests pay you by bank transfer or PayPal."
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
      {snapshot.pricingCurrency.current ? (
        <p className="text-sm text-gray-600">
          Property currency: <strong>{snapshot.pricingCurrency.current.currency}</strong>. Prices
          and payment methods use this currency.
        </p>
      ) : (
        // Payment methods need the currency, so a new hotel can choose it here without first
        // visiting Pricing (VAY-2137).
        <HotelCurrencyChoice
          propertyId={props.propertyId}
          disabled={draft.saving}
          onSaved={draft.rebase}
          onNotice={setNotice}
        />
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
      {manual.acceptanceEnabled && (
        <AdaptiveStepCard>
          <h2 className="text-lg font-semibold">Bank transfer or PayPal</h2>
          <p className="mt-3 text-sm text-gray-600">
            Guests pay you directly. Add your bank details or PayPal email in Booking Engine
            settings &gt; Payments.
          </p>
          <p className="mt-2 text-sm text-gray-600">
            Bank transfer and PayPal bookings need your manual confirmation: you mark each payment
            as received in the PMS.
          </p>
          <p className="mt-4 text-sm font-semibold">
            {manual.readyMethods.length
              ? `Ready: ${manual.readyMethods.map((method) => manualLabels[method]).join(", ")}`
              : "Not set up"}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className={adaptiveSecondaryButtonClass}
              disabled={draft.saving}
              onClick={() => void openPaymentSettings()}
            >
              Open payment settings
            </button>
            <button
              type="button"
              className={adaptiveSecondaryButtonClass}
              disabled={draft.saving}
              // Keeps the answers, moves onto the newest saved settings and reloads this step.
              onClick={() =>
                void draft
                  .rebase()
                  .catch((cause) => setManualError(adaptiveStepErrorMessage(cause)))
              }
            >
              Check again
            </button>
          </div>
          {manualError && (
            <p role="alert" className="mt-3 text-sm text-red-800">
              {manualError}
            </p>
          )}
        </AdaptiveStepCard>
      )}
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
      <BillingPlanChoice
        propertyId={props.propertyId}
        disabled={draft.saving}
        onStatus={setPlan}
        onChanged={props.refreshRoute}
      />
      {plan && !planSettled && (
        <p className="text-right text-sm text-gray-600">Confirm your vayada plan to continue.</p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          className={adaptiveSecondaryButtonClass}
          disabled={
            draft.saving || (!selection.length && !manualReady) || !snapshot.pricingCurrency.current
          }
          onClick={() => void save(false)}
        >
          {draft.saving ? "Saving…" : "Save selection"}
        </button>
        <button
          type="button"
          className={adaptivePrimaryButtonClass}
          disabled={
            draft.saving ||
            !planSettled ||
            (!manualContinue && (!matchesSaved || !snapshot.bookingPaymentReady))
          }
          onClick={() => void (manualContinue ? continueWithManual() : save(true))}
        >
          {manualContinue ? "Continue" : "Save and continue"}
        </button>
      </div>
    </div>
  );
}
