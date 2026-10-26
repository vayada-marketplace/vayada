"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ManualPaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import type {
  PricingCardReadiness,
  PricingRateNotSelling,
} from "@vayada/product-onboarding/replacementPricingClient";

const ManualMethods = createContext<readonly ManualPaymentMethod[]>([]);

/** Bank transfer and PayPal the rate pickers may offer, loaded once per pricing editor (VAY-2139). */
export const PricingManualMethodsProvider = ManualMethods.Provider;
export const usePricingManualMethods = () => useContext(ManualMethods);

export function useLoadedPricingManualMethods(client: {
  paymentMethods(): Promise<ManualPaymentMethod[]>;
}): readonly ManualPaymentMethod[] {
  const [methods, setMethods] = useState<readonly ManualPaymentMethod[]>([]);
  useEffect(() => {
    let current = true;
    // Unknown reads as none: the pickers show card and pay at property, as before.
    client.paymentMethods().then(
      (value) => {
        if (current) setMethods(value);
      },
      () => {
        if (current) setMethods([]);
      },
    );
    return () => {
      current = false;
    };
  }, [client]);
  return methods;
}

const CardReadiness = createContext<PricingCardReadiness | null>(null);

/** Whether the booking page can take card now, and when it charges (VAY-2205), loaded once per pricing editor. Null
 * until it is read or when it can't be: the rate pickers then don't offer card. */
export const PricingCardReadinessProvider = CardReadiness.Provider;
export const usePricingCardReadiness = () => useContext(CardReadiness);

export function useLoadedPricingCardReadiness(client: {
  cardReadiness(): Promise<PricingCardReadiness>;
}): PricingCardReadiness | null {
  const [readiness, setReadiness] = useState<PricingCardReadiness | null>(null);
  useEffect(() => {
    let current = true;
    client.cardReadiness().then(
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
  }, [client]);
  return readiness;
}

const NotSelling = createContext<readonly PricingRateNotSelling[]>([]);

/** The published rates guests can't book now, and why (VAY-2304), read once per editor and again after each
 * publication (`revision`). Unknown reads as none: the rate cards say nothing. */
export const PricingNotSellingProvider = NotSelling.Provider;
export const usePricingNotSelling = () => useContext(NotSelling);

export function useLoadedPricingNotSelling(
  client: { notSellingRates(): Promise<PricingRateNotSelling[]> },
  revision: number,
): readonly PricingRateNotSelling[] {
  const [rates, setRates] = useState<readonly PricingRateNotSelling[]>([]);
  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(() => client.notSellingRates())
      .then(
        (value) => {
          if (current) setRates(value ?? []);
        },
        () => {
          if (current) setRates([]);
        },
      );
    return () => {
      current = false;
    };
  }, [client, revision]);
  return rates;
}
