"use client";

import { Elements } from "@stripe/react-stripe-js";
import stripeForAccount from "@/lib/stripe";

interface StripeProviderProps {
  clientSecret: string;
  stripeAccountId?: string | null;
  /** vayada Payment (VAY-2442): the key of the Stripe account that takes the payment. */
  publishableKey?: string | null;
  children: React.ReactNode;
}

export default function StripeProvider({
  clientSecret,
  stripeAccountId,
  publishableKey,
  children,
}: StripeProviderProps) {
  return (
    <Elements
      stripe={stripeForAccount(stripeAccountId, publishableKey)}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#1a1a2e",
            borderRadius: "8px",
          },
        },
      }}
    >
      {children}
    </Elements>
  );
}
