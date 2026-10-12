"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ManualPaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";

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
