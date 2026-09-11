"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import { financePaymentReadinessClient as client } from "@/services/api/financePaymentReadinessClient";
import { hotelOperationsSetupApi } from "@/services/api/hotelOperationsSetupClient";
import { getAuthSessionUser } from "@/services/auth/sessionStore";
import {
  coordinateStripeRefresh,
  markStripeOnboardingStarted,
  refreshStripeAfterOnboarding,
  watchStripeOnboardingRefresh,
} from "@/lib/utils/stripeOnboardingRefresh";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  adaptiveSecondaryButtonClass,
} from "../AdaptiveStepPrimitives";
import { adaptiveStepErrorMessage } from "../adaptiveSetupStepState";

import {
  saveStripeSetupReturnContext,
  restoreStripeSetupReturnContext,
} from "./stripeSetupReturnContext";

export function StripeSetupControls({
  organizationId,
  propertyId,
  enabled,
  visible,
  onReadiness,
}: {
  organizationId: string;
  propertyId: string;
  enabled: boolean;
  visible: boolean;
  onReadiness: (value: FinancePaymentReadinessSnapshot) => void;
}) {
  const callback = useRef(onReadiness);
  useEffect(() => {
    callback.current = onReadiness;
  }, [onReadiness]);
  const active = useRef<AbortController | null>(null);
  const attempt = useRef<string | null>(null);
  const [email, setEmail] = useState(() => getAuthSessionUser()?.email ?? "");
  const [country, setCountry] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    async (flowId: string, mode: "reconcile" | "reload" = "reconcile") => {
      if (active.current) return false;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError(null);
      try {
        const load = () =>
          client.load(propertyId, { signal: controller.signal, cache: "no-store" });
        const value = await coordinateStripeRefresh(
          { propertyId, signal: controller.signal, locks: navigator.locks },
          () =>
            mode === "reload"
              ? load()
              : refreshStripeAfterOnboarding(controller.signal, {
                  reconcile: (index) =>
                    hotelOperationsSetupApi.reconcileStripeProviderAccount(
                      propertyId,
                      `${flowId}:attempt:${index + 1}`,
                      controller.signal,
                    ),
                  loadPaymentSettings: load,
                }),
          load,
        );
        if (controller.signal.aborted) return false;
        callback.current(value);
        return true;
      } catch (cause) {
        if (!controller.signal.aborted) setError(adaptiveStepErrorMessage(cause));
        // A failed check is retryable explicitly, without endless focus requests.
        return !controller.signal.aborted;
      } finally {
        if (active.current === controller) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [propertyId],
  );
  useEffect(() => {
    const restored = restoreStripeSetupReturnContext(
      stripeStore(),
      organizationId,
      propertyId,
      window.location.href,
    );
    if (restored) {
      window.location.replace(restored);
      return;
    }
    const url = new URL(window.location.href);
    const returned = url.searchParams.get("stripe");
    const isStripeReturn = returned === "return" || returned === "refresh";
    if (isStripeReturn) {
      url.searchParams.delete("stripe");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    const stop = watchStripeOnboardingRefresh({
      propertyId,
      isStripeReturn,
      target: window,
      store: stripeStore(),
      onRefresh: refresh,
    });
    return () => {
      stop();
      active.current?.abort();
    };
  }, [organizationId, propertyId, refresh]);
  useEffect(() => {
    if (!enabled) setLink("");
  }, [enabled]);
  async function prepare() {
    if (!enabled || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    setLink("");
    try {
      const providerAccountId = await client.providerAccountId(propertyId, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (
        !providerAccountId &&
        (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !/^[A-Z]{2}$/.test(country.trim()))
      )
        throw new Error("Enter your Stripe account email and two-letter business country code.");
      attempt.current ??= crypto.randomUUID();
      const value = await hotelOperationsSetupApi.startStripeOnboarding(propertyId, {
        email,
        country,
        providerAccountId,
        linkAttemptId: attempt.current,
      });
      const url = new URL(value.onboardingUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "connect.stripe.com" ||
        url.username ||
        url.password
      )
        throw new Error("Stripe returned an invalid onboarding link. Try again.");
      if (controller.signal.aborted) return;
      setLink(url.toString());
      attempt.current = null;
    } catch (cause) {
      if (!controller.signal.aborted) setError(adaptiveStepErrorMessage(cause));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  if (!visible) return error ? <AdaptiveSaveError message={error} /> : null;
  return (
    <AdaptiveStepCard>
      <h2 className="text-lg font-semibold">Stripe account</h2>
      <p className="mt-2 text-sm text-gray-600">
        Save your selection before connecting Stripe. Account setup opens in a new tab. Account
        connection alone does not make online cards ready.
      </p>
      {error && <AdaptiveSaveError message={error} />}
      <fieldset disabled={!enabled || busy} className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium">
          Stripe account email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5"
          />
        </label>
        <label className="text-sm font-medium">
          Business country code
          <input
            value={country}
            maxLength={2}
            placeholder="e.g. DE"
            onChange={(event) => setCountry(event.target.value.toUpperCase())}
            className="mt-2 block w-full rounded-lg border border-gray-300 px-3 py-2.5"
          />
        </label>
        <p className="text-sm text-gray-600 md:col-span-2">
          Email and country are required only for a new Stripe account.
        </p>
        <button
          type="button"
          className={adaptiveSecondaryButtonClass}
          onClick={() => void prepare()}
        >
          Prepare Stripe setup
        </button>
        <button
          type="button"
          className={adaptiveSecondaryButtonClass}
          onClick={() => void refresh(`stripe-refresh-${crypto.randomUUID()}`)}
        >
          {busy ? "Checking…" : "Check payment readiness"}
        </button>
      </fieldset>
      {link && enabled && !busy && (
        <a
          className={`${adaptiveSecondaryButtonClass} mt-4 inline-flex`}
          href={link}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            saveStripeSetupReturnContext(
              stripeStore(),
              organizationId,
              propertyId,
              window.location.href,
            );
            markStripeOnboardingStarted(propertyId, stripeStore());
          }}
        >
          Open Stripe
        </a>
      )}
    </AdaptiveStepCard>
  );
}

function stripeStore() {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}
