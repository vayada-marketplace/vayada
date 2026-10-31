"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import {
  AcceptedPaymentMethods,
  paidInAdvance,
  type ManualPaymentMethod,
  type PaymentMethod,
} from "@vayada/product-onboarding/AcceptedPaymentMethods";
import type { SetupRoom } from "@vayada/product-onboarding/FirstPricingSetup";
import { englishPricingSetup } from "@vayada/product-onboarding/firstPricingSetupMessages";

import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  newPublishProgress,
  publishFirstPricing,
  type CurrentPublication,
  type FirstPricing,
} from "./publishFirstPricing";
import {
  defaultCancellation,
  freeCancellationDays,
  paymentsStepMethods,
  setupRates,
  type SetupCancellation,
} from "./setupRates";
import { ApiErrorResponse } from "@/services/api/client";
import { financePaymentReadinessClient } from "@/services/api/financePaymentReadinessClient";
import {
  onboardingPricingApi,
  PricingOwnerError,
  type OnboardingPricingOwners,
} from "@/services/api/onboardingPricingClient";

type Loaded = { owners: OnboardingPricingOwners; publication: CurrentPublication };
/** Something to fill in before publishing: a room's price (keyed by the room) or how guests pay ("pay"). */
type Problem = { key: string; text: string };

// The Payments step's names for the ways to pay.
const methodWords: Record<PaymentMethod, string> = {
  pay_at_property: "Pay at hotel",
  card: "Online card",
  bank_transfer: "Bank transfer",
  paypal: "PayPal",
};

/**
 * First pricing of a new hotel (VAY-2188): one property currency, a price per night for every
 * operating room, one cancellation choice and the ways to pay from the Payments step, published
 * as pricing-v2 offers with the final-price confirmation. Children under 12 stay free and there is
 * no minimum stay; seasons, meals and more are set later in each room's Prices tab in the PMS.
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
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [cancellation, setCancellation] = useState<SetupCancellation>(defaultCancellation);
  // The Payments step's choice (undefined while it loads, null when it can't be read); `picked`
  // counts only while the step has to ask.
  const [readiness, setReadiness] = useState<FinancePaymentReadinessSnapshot | null | undefined>();
  const [picked, setPicked] = useState<PaymentMethod[] | null>(null);
  const [missing, setMissing] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null);
  const progress = useRef(newPublishProgress());
  // One offer id per room for a publish attempt, so pressing Publish again resumes it.
  const offerIds = useRef<Record<string, string>>({});
  const running = useRef(false);
  const lastAction = useRef<() => Promise<void>>(async () => undefined);
  const mounted = useRef(true);
  const [manualMethods, setManualMethods] = useState<ManualPaymentMethod[]>([]);
  useEffect(() => {
    let current = true;
    // First prices may take bank transfer and PayPal only while they can be used (VAY-2139).
    pricingClient.paymentMethods().then(
      (value) => {
        if (current) setManualMethods(value);
      },
      () => {
        if (current) setManualMethods([]);
      },
    );
    return () => {
      current = false;
    };
  }, [pricingClient]);
  useEffect(() => {
    let current = true;
    financePaymentReadinessClient.load(propertyId).then(
      (value) => {
        if (current) setReadiness(value);
      },
      () => {
        if (current) setReadiness(null);
      },
    );
    return () => {
      current = false;
    };
  }, [propertyId, reload]);
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
  const unpriced = owners.rooms.filter(({ roomTypeId }) => !publishedRoomIds.has(roomTypeId));
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
  const complete = allPriced && !stale && step.state === "complete";
  const stepMethods =
    readiness === undefined
      ? undefined
      : readiness && paymentsStepMethods(readiness, manualMethods);
  const methods = stepMethods ?? picked ?? [];
  // Guests can only pay at the property: non-refundable stays (paid in advance) can't be offered (VAY-2280).
  const onlyAtProperty = methods.length > 0 && !paidInAdvance(methods).length;
  // A flexible rate starts as "Nothing paid when booking" (VAY-2205): say so when other ways are chosen too.
  const atPropertyHint = cancellation.kind === "free" &&
    methods.includes("pay_at_property") &&
    paidInAdvance(methods).length > 0 && (
      <span className="mt-1 block text-xs text-gray-600">
        Guests pay at the property. Rates paid when booking, set later in Rooms &amp; Rates, use the
        other ways.
      </span>
    );
  const pricing = !!currency && !currencyMismatch && setupRooms.length > 0 && !paymentsPending;
  const children = setupRooms.some(({ capacity }) => capacity.children > 0);
  /** An edit starts a new publish attempt; `solved` names the problem it fixes. */
  const changed = (solved?: string) => {
    progress.current = newPublishProgress();
    offerIds.current = {};
    lastAction.current = async () => undefined;
    setError(null);
    if (solved) setMissing((previous) => previous.filter(({ key }) => key !== solved));
  };

  const finish = async (rates: FirstPricing[]) => {
    if (rates.length > 0 || stale) {
      await publishFirstPricing(pricingClient, publication, rates, progress.current);
      const published = await pricingClient.read();
      if (!mounted.current) return;
      setLoaded({ owners, publication: published });
      setPrices({});
    }
    await refreshRoute();
    await saveAndContinue();
  };
  const publishPrices = () => {
    // Each room is built on its own, so a price that doesn't parse is named with its room.
    const problems: Problem[] = [];
    const rates: FirstPricing[] = [];
    // Non-refundable stays are paid in advance, so they need a way to pay other than at the property (VAY-2280).
    const noAdvance = cancellation.kind === "non_refundable" && !paidInAdvance(methods).length;
    for (const room of setupRooms) {
      if (!prices[room.roomTypeId]?.trim()) {
        problems.push({ key: room.roomTypeId, text: `A price per night for ${room.name}` });
        continue;
      }
      if (!methods.length || noAdvance) continue;
      try {
        rates.push(
          ...setupRates(
            propertyId.toLowerCase(),
            [room],
            prices,
            currency!,
            cancellation,
            methods,
            (roomTypeId) => (offerIds.current[roomTypeId] ??= crypto.randomUUID()),
          ),
        );
      } catch {
        problems.push({
          key: room.roomTypeId,
          text: `A price per night for ${room.name} in numbers only, like 89.50`,
        });
      }
    }
    if (setupRooms.length && !methods.length) problems.push({ key: "pay", text: "How guests pay" });
    else if (setupRooms.length && noAdvance)
      problems.push({ key: "pay", text: "A way to pay in advance for non-refundable stays" });
    setMissing(problems);
    if (problems.length) return;
    void run(() => finish(rates));
  };
  const startOver = async () => {
    setPrices({});
    changed();
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

      {(!currency || currencyMismatch) && (
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
      )}

      <section className="border-t border-gray-200 pt-8" aria-labelledby="room-rates-heading">
        <SectionHeading
          id="room-rates-heading"
          title="Price per night"
          description={`One price for each room${currency ? `. All prices are in ${currency}` : ""}.`}
        />
        {owners.rooms.length === 0 ? (
          <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            Complete at least one room before setting prices.
          </p>
        ) : (
          <ul className="mt-5 space-y-3">
            {owners.rooms.map((room) => {
              const offers =
                publication?.rooms.find(({ roomTypeId }) => roomTypeId === room.roomTypeId)?.offers
                  .length ?? 0;
              const { maxAdults, maxChildren } = room.facts.occupancy;
              const empty = missing.some(({ key }) => key === room.roomTypeId);
              return (
                <li
                  key={room.roomTypeId}
                  className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white px-4 py-3.5"
                >
                  <div className="min-w-0 grow">
                    <p className="font-semibold text-gray-950">{room.facts.name}</p>
                    <p className="text-sm text-gray-600">
                      {maxAdults === 1 ? "1 adult" : `Up to ${maxAdults} adults`}
                      {maxChildren > 0 &&
                        ` and ${maxChildren} ${maxChildren === 1 ? "child" : "children"}`}
                    </p>
                  </div>
                  {offers > 0 ? (
                    <span className="text-sm text-emerald-800">
                      Published · {offers} {offers === 1 ? "rate" : "rates"}
                    </span>
                  ) : pricing ? (
                    <label className="flex items-center gap-3 text-sm text-gray-600">
                      <span
                        className={`flex h-11 w-44 items-center gap-2 rounded-lg bg-gray-100 px-3 focus-within:ring-2 focus-within:ring-primary-600 ${empty ? "ring-2 ring-red-400" : ""}`}
                      >
                        <span aria-hidden="true" className="text-gray-600">
                          {currency}
                        </span>
                        <input
                          aria-label={`Price per night for ${room.facts.name}`}
                          aria-invalid={empty || undefined}
                          inputMode="decimal"
                          disabled={busy}
                          value={prices[room.roomTypeId] ?? ""}
                          onChange={(event) => {
                            setPrices({ ...prices, [room.roomTypeId]: event.target.value });
                            changed(room.roomTypeId);
                          }}
                          className="min-w-0 grow bg-transparent text-base font-semibold text-gray-950 outline-none"
                        />
                      </span>
                      per night
                    </label>
                  ) : (
                    <span className="text-sm text-amber-800">Needs a price</span>
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
              message="Rates are checked against the hotel's payment methods, so Payments comes before prices. Go back to Payments, save how guests pay, then continue here."
              actionLabel="Back to Payments"
              onAction={() => goToStep?.("payments")}
            />
          </div>
        )}
      </section>

      {pricing && (
        <section className="border-t border-gray-200 pt-8" aria-labelledby="cancellation-heading">
          <SectionHeading
            id="cancellation-heading"
            title="Cancellation"
            description="The same for every room. You can change it per room later in the PMS."
          />
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Cancellation">
            {(
              [
                ["free", "Free cancellation"],
                ["non_refundable", "Non-refundable"],
              ] as const
            ).map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                aria-pressed={cancellation.kind === kind}
                disabled={
                  busy ||
                  (kind === "non_refundable" && cancellation.kind !== kind && onlyAtProperty)
                }
                onClick={() => {
                  setCancellation(
                    kind === "free"
                      ? { kind, days: cancellation.kind === "free" ? cancellation.days : 3 }
                      : { kind },
                  );
                  changed();
                }}
                className={chip(cancellation.kind === kind)}
              >
                {label}
              </button>
            ))}
          </div>
          {onlyAtProperty && (
            <p className="mt-3 text-sm text-gray-600">
              Non-refundable stays are paid in advance, so they can&apos;t be paid at the property.
              To offer them, make bank transfer ready in Payments.
            </p>
          )}
          {cancellation.kind === "free" && (
            <label className="mt-4 flex flex-wrap items-center gap-2.5 text-sm text-gray-800">
              Guests can cancel for free until
              <select
                aria-label="Days before arrival"
                disabled={busy}
                value={cancellation.days}
                onChange={(event) => {
                  setCancellation({ kind: "free", days: Number(event.target.value) });
                  changed();
                }}
                className="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-950"
              >
                {freeCancellationDays.map((days) => (
                  <option key={days} value={days}>
                    {days === 1 ? "1 day" : `${days} days`}
                  </option>
                ))}
              </select>
              before arrival.
            </label>
          )}
        </section>
      )}

      {pricing && (
        <section className="border-t border-gray-200 pt-8" aria-labelledby="pay-heading">
          <SectionHeading
            id="pay-heading"
            title="How guests pay"
            description="Taken from the Payments step."
          />
          {stepMethods === undefined ? (
            <p className="mt-4 text-sm text-gray-600" role="status">
              Loading how guests pay...
            </p>
          ) : stepMethods ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
              <span className="grow text-sm text-gray-900">
                {stepMethods.map((method) => methodWords[method]).join(" · ")}
                {cancellation.kind === "non_refundable" &&
                  stepMethods.includes("pay_at_property") && (
                    <span className="mt-1 block text-xs text-amber-700">
                      Pay at property: not offered, non-refundable stays are paid in advance
                    </span>
                  )}
                {atPropertyHint}
              </span>
              <button
                type="button"
                aria-label="Change how guests pay"
                disabled={busy}
                className="text-sm font-semibold text-primary-700 underline disabled:opacity-50"
                onClick={() => goToStep?.("payments")}
              >
                Change
              </button>
            </div>
          ) : (
            <div
              className={`mt-4 rounded-xl border bg-white px-4 py-3 ${missing.some(({ key }) => key === "pay") ? "border-red-400" : "border-gray-200"}`}
            >
              <p className="mb-2 text-sm text-gray-700">
                {readiness === null
                  ? "The Payments step's choice couldn't be read, so choose how guests pay."
                  : "None of the ways to pay from the Payments step is ready yet. Choose how guests pay, or finish Payments first."}
              </p>
              <AcceptedPaymentMethods
                methods={methods}
                disabled={busy}
                manualMethods={manualMethods}
                nonRefundable={cancellation.kind === "non_refundable"}
                onChange={(next) => {
                  setPicked(next);
                  changed(next.length ? "pay" : undefined);
                }}
                t={englishPricingSetup}
              />
              {atPropertyHint}
            </div>
          )}
          <p className="mt-6 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-gray-700">
            {children
              ? "Children under 12 stay free and there is no minimum stay."
              : "There is no minimum stay."}{" "}
            Seasons, weekend prices, breakfast and more can be added later in Rooms &amp; Rates,
            room by room.
          </p>
        </section>
      )}

      {missing.length > 0 && (
        <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-sm font-semibold text-red-950">Fill in what is still missing:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-red-900">
            {missing.map(({ key, text }) => (
              <li key={key}>{text}</li>
            ))}
          </ul>
        </div>
      )}

      {allPriced && stale && (
        <p
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          Rooms, rate terms or payment settings changed since these prices were published, so guests
          cannot book them yet. Publish the prices again to confirm them.
        </p>
      )}

      {allPriced && !stale && !complete && (
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
              disabled={
                busy ||
                currencyMismatch ||
                !(pricing || (allPriced && stale)) ||
                (pricing && stepMethods === undefined)
              }
              aria-describedby="publish-prices-declaration"
              className={primaryButton}
              onClick={pricing ? publishPrices : () => void run(() => finish([]))}
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
const chip = (selected: boolean) =>
  `min-h-10 rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? "border-primary-600 bg-primary-600 font-semibold text-white"
      : "border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
  }`;
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
