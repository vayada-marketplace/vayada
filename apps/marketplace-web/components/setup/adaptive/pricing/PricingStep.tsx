"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FirstPricingSetup, type SetupRoom } from "@vayada/product-onboarding/FirstPricingSetup";
import {
  englishPricingSetup,
  type Translate,
} from "@vayada/product-onboarding/firstPricingSetupMessages";

import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  newPublishProgress,
  publishFirstPricing,
  type CurrentPublication,
  type FirstPricing,
} from "./publishFirstPricing";
import { ApiErrorResponse } from "@/services/api/client";
import {
  onboardingPricingApi,
  PricingOwnerError,
  type OnboardingPricingOwners,
} from "@/services/api/onboardingPricingClient";

type Loaded = { owners: OnboardingPricingOwners; publication: CurrentPublication };

/** The shared form's English text, except where it describes the PMS editor's draft flow. */
const onboardingText: Record<string, string> = {
  // The currency is always fixed here, which the form reads as "another room".
  "pricing.setup.titleAnotherRoom": "Set a room rate",
  "pricing.setup.continue": "Add this rate",
  "pricing.setup.continueHint":
    "Added rates are published together when you publish prices below. Nothing is sent to channels.",
};
const t: Translate = (key, params) => onboardingText[key] ?? englishPricingSetup(key, params);

/**
 * First pricing of a new hotel: one property currency, a first rate for every operating room
 * through the shared PMS first-setup form, published as pricing-v2 offers, and the final-price
 * confirmation. Later price changes happen in each room's Prices tab in the PMS.
 */
export function PricingStep({
  route,
  step,
  propertyId,
  saveAndContinue,
  refreshRoute,
  goToStep,
}: AdaptiveSetupStepComponentProps) {
  const pricingClient = useMemo(
    () => onboardingPricingApi.replacementPricing(propertyId),
    [propertyId],
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [currencyChoice, setCurrencyChoice] = useState("");
  const [added, setAdded] = useState<FirstPricing[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null);
  const progress = useRef(newPublishProgress());
  const running = useRef(false);
  const lastAction = useRef<() => Promise<void>>(async () => undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (step.stepId !== "pricing" || propertyId.toLowerCase() !== route.scope.propertyId) {
      setLoadError("This pricing step does not match the selected hotel.");
      return () => controller.abort();
    }
    setLoaded(null);
    setLoadError(null);
    void Promise.all([
      onboardingPricingApi.load(propertyId, {
        cache: "no-store",
        signal: controller.signal,
      }),
      pricingClient.read(),
    ])
      .then(([owners, publication]) => {
        if (controller.signal.aborted) return;
        progress.current = newPublishProgress();
        setLoaded({ owners, publication });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [pricingClient, propertyId, reload, route.scope.propertyId, step.stepId]);

  const run = useCallback(async (action: () => Promise<void>) => {
    // A ref, not `busy`: two clicks in one frame both see the old state.
    if (running.current) return;
    running.current = true;
    lastAction.current = action;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (!mounted.current) return;
      const conflict =
        (cause instanceof ApiErrorResponse && cause.status === 409) ||
        (cause instanceof PricingOwnerError && cause.requiresRefresh);
      setError({ message: publishErrorMessage(cause), reload: conflict });
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  if (loadError) {
    return (
      <Panel
        title="Pricing could not be loaded"
        message={loadError}
        actionLabel="Retry"
        onAction={() => setReload((value) => value + 1)}
      />
    );
  }
  if (!loaded) return <PricingSkeleton />;

  const { owners, publication } = loaded;
  const currency = owners.pricing?.pricingCurrency.currency ?? null;
  const publishedRoomIds = new Set(
    publication?.rooms
      .filter(({ offers }) => offers.length > 0)
      .map(({ roomTypeId }) => roomTypeId),
  );
  const addedRoomIds = new Set(added.map(({ configuration }) => configuration.roomTypeId));
  const unpriced = owners.rooms.filter(
    ({ roomTypeId }) => !publishedRoomIds.has(roomTypeId) && !addedRoomIds.has(roomTypeId),
  );
  const setupRooms: SetupRoom[] = unpriced.map((room) => ({
    roomTypeId: room.roomTypeId,
    name: room.facts.name,
    capacity: {
      total: room.facts.occupancy.maxGuests,
      adults: room.facts.occupancy.maxAdults,
      children: room.facts.occupancy.maxChildren,
    },
  }));
  const currencyMismatch = !!publication && !!currency && publication.currency !== currency;
  const payments = route.steps.find(({ stepId }) => stepId === "payments");
  const paymentsPending = !!payments && payments.state !== "complete";
  const allPriced = owners.rooms.length > 0 && unpriced.length === 0;
  // Rooms, terms or payment settings changed after publishing: guests see no prices until the
  // current prices are published again (the PMS editor allows the same re-save).
  const stale = !!publication?.stale;
  // The server completes the step: every operating room published and prices confirmed final.
  const complete = allPriced && added.length === 0 && !stale && step.state === "complete";

  const finish = async () => {
    if (added.length > 0 || stale) {
      await publishFirstPricing(pricingClient, publication, added, progress.current);
      const published = await pricingClient.read();
      if (!mounted.current) return;
      setLoaded({ owners, publication: published });
      setAdded([]);
    }
    await refreshRoute();
    await saveAndContinue();
  };
  const startOver = async () => {
    setAdded([]);
    setError(null);
    await refreshRoute();
    setReload((value) => value + 1);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10">
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-4" role="alert">
          <p className="text-sm font-semibold text-red-950">Pricing was not saved</p>
          <p className="mt-1 text-sm leading-6 text-red-900">{error.message}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void (error.reload ? startOver() : run(lastAction.current))}
            className={secondaryButton}
          >
            {error.reload ? "Reload pricing" : "Try again"}
          </button>
        </div>
      )}

      <section aria-labelledby="pricing-currency-heading">
        <SectionHeading
          id="pricing-currency-heading"
          title="Currency"
          description="One currency for every room, rate and payment method of this hotel."
        />
        {currency ? (
          <p className="mt-4 text-sm text-gray-800">
            All prices are in <strong>{currency}</strong>.
          </p>
        ) : (
          <div className="mt-4 flex max-w-md flex-wrap items-end gap-3">
            <label className="block grow text-sm font-semibold text-gray-900">
              Hotel pricing currency
              <select
                value={currencyChoice}
                onChange={(event) => setCurrencyChoice(event.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  Choose currency
                </option>
                {owners.currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !currencyChoice}
              className={secondaryButton}
              onClick={() =>
                void run(async () => {
                  const next = await onboardingPricingApi.saveCurrency(
                    propertyId,
                    currencyChoice,
                    owners,
                  );
                  if (mounted.current) setLoaded({ owners: next, publication });
                })
              }
            >
              Save currency
            </button>
          </div>
        )}
        {currencyMismatch && (
          <p className="mt-3 text-sm text-red-800" role="alert">
            Published prices are in {publication.currency}, but the hotel currency is {currency}.
            Update the prices in the PMS before continuing.
          </p>
        )}
      </section>

      <section className="border-t border-gray-200 pt-8" aria-labelledby="room-rates-heading">
        <SectionHeading
          id="room-rates-heading"
          title="Room rates"
          description="Give every room a first rate. Guests booking directly need a rate with free cancellation for each room. Seasons, weekdays, meal plans and more rates are edited later in the PMS, in each room's Prices tab under Rooms & Rates."
        />
        {owners.rooms.length === 0 ? (
          <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            Complete at least one room before setting prices.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white">
            {owners.rooms.map((room) => {
              const pending = added.find(
                ({ configuration }) => configuration.roomTypeId === room.roomTypeId,
              );
              const offers =
                publication?.rooms.find(({ roomTypeId }) => roomTypeId === room.roomTypeId)?.offers
                  .length ?? 0;
              return (
                <li key={room.roomTypeId} className="flex items-center justify-between gap-4 p-4">
                  <span className="font-medium text-gray-950">{room.facts.name}</span>
                  {offers > 0 ? (
                    <span className="text-sm text-emerald-800">
                      Published · {offers} {offers === 1 ? "rate" : "rates"}
                    </span>
                  ) : pending ? (
                    <span className="flex items-center gap-3 text-sm text-gray-700">
                      Ready to publish
                      <button
                        type="button"
                        disabled={busy}
                        className="text-sm font-semibold text-primary-700 underline disabled:opacity-50"
                        onClick={() => {
                          setAdded((items) => items.filter((item) => item !== pending));
                          progress.current = newPublishProgress();
                        }}
                      >
                        Change
                      </button>
                    </span>
                  ) : (
                    <span className="text-sm text-amber-800">Needs a rate</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {currency && !currencyMismatch && setupRooms.length > 0 && paymentsPending && (
          <div className="mt-6">
            <Panel
              title="Choose how guests pay first"
              message="Rates are checked against the hotel's payment methods. Complete Payments, then come back here to set room rates."
              actionLabel="Go to Payments"
              onAction={() => goToStep?.("payments")}
            />
          </div>
        )}
        {currency && !currencyMismatch && setupRooms.length > 0 && !paymentsPending && (
          <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
            <FirstPricingSetup
              key={setupRooms.map(({ roomTypeId }) => roomTypeId).join()}
              propertyId={propertyId.toLowerCase()}
              rooms={setupRooms}
              fixedCurrency={currency}
              disabled={busy}
              onDirty={() => setError(null)}
              onCreate={(input) => {
                setAdded((items) => [...items, input]);
                progress.current = newPublishProgress();
              }}
              t={t}
            />
          </div>
        )}
      </section>

      {allPriced && added.length === 0 && stale && (
        <p
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          Rooms, rate terms or payment settings changed since these prices were published, so guests
          cannot book them yet. Publish the prices again to confirm them.
        </p>
      )}

      {allPriced && added.length === 0 && !stale && !complete && (
        <Panel
          title="Pricing is not complete yet"
          message="Every room has a published rate, but setup has not confirmed it. Reload pricing; if this stays, check the room rates in the PMS, in each room's Prices tab under Rooms & Rates."
          actionLabel="Reload pricing"
          onAction={() => void startOver()}
        />
      )}

      <div className="flex flex-col items-stretch gap-3 border-t border-gray-200 pt-6 sm:items-end">
        {complete ? (
          <button
            type="button"
            disabled={busy}
            className={primaryButton}
            onClick={() => void run(saveAndContinue)}
          >
            Continue
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={busy || !allPriced || (added.length === 0 && !stale) || currencyMismatch}
              aria-describedby="publish-prices-declaration"
              className={primaryButton}
              onClick={() => void run(finish)}
            >
              {busy ? "Publishing prices..." : "Publish prices and continue"}
            </button>
            {/* Publishing records the "all mandatory charges included" declaration (VAY-2079). */}
            <p id="publish-prices-declaration" className="text-sm text-gray-600">
              By publishing, you confirm these prices include all mandatory taxes and fees.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Prepare's 403 reasons when Finance is not ready, as the PMS editor shows them. Rates entered
 * here are lost when the owner leaves the step, so the copy promises nothing about them. */
const financeReasons: Record<string, string> = {
  settings_missing:
    "Payments are not set up for this hotel yet. Complete the Payments step, then come back to publish the rates.",
  payments_disabled:
    "Payments are switched off for this hotel. Turn them on in the Payments step, then come back to publish the rates.",
  currency_mismatch:
    "These prices use a different currency from the hotel's payment settings. Fix the payment currency, then publish again.",
  method_unavailable:
    "A payment method chosen for these rates is not ready. Change the rate to accept pay at property, or finish card setup, then publish again.",
  deposit_execution_unavailable:
    "Deposit payment terms cannot be saved yet. Change the rate to full payment, then publish again.",
};

function publishErrorMessage(cause: unknown): string {
  if (cause instanceof ApiErrorResponse && cause.status === 403) {
    const reason = (cause.data as { reason?: unknown }).reason;
    if (typeof reason === "string" && Object.hasOwn(financeReasons, reason))
      return financeReasons[reason]!;
    if (cause.data.code === "forbidden")
      return "You no longer have access to pricing for this hotel.";
    return "Prices could not be prepared. Check that Payments is complete and accepts the payment methods chosen for these rates.";
  }
  if (cause instanceof ApiErrorResponse && cause.status === 409) {
    return "Pricing changed in another session. Reload pricing and enter the rates again.";
  }
  return errorMessage(cause);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Pricing could not be saved. Try again.";
}

const inputClass =
  "mt-2 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 outline-none focus-visible:border-primary-600 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-1";
const secondaryButton =
  "mt-3 min-h-11 rounded-full border border-gray-300 bg-white px-5 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-gray-400";
const primaryButton =
  "min-h-11 whitespace-nowrap rounded-full bg-primary-600 px-6 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300";

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 id={id} className="text-lg font-semibold text-gray-950">
        {title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">{description}</p>
    </div>
  );
}

function Panel({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-5" role="alert">
      <h2 className="text-sm font-semibold text-amber-950">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-amber-900">{message}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-3 min-h-11 rounded-full border border-amber-500 bg-white px-4 text-sm font-semibold text-amber-950 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function PricingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" role="status" aria-label="Loading pricing">
      <div className="h-24 animate-pulse rounded-xl bg-gray-200" />
      <div className="h-40 animate-pulse rounded-xl bg-gray-200" />
      <span className="sr-only">Loading pricing...</span>
    </div>
  );
}
