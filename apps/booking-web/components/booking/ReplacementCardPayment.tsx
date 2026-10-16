"use client";

import { useRef, useState } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import StripeProvider from "@/components/StripeProvider";
import { ApiError } from "@/services/api/client";
import { deviceTimeOf } from "@/lib/serverClock";
import { trackEvent } from "@/services/api/tracking";
import {
  completePricingCardPayment,
  type PricingCardPaymentRequired,
  type PricingCardPaymentResult,
} from "@/services/api/pricingAcceptance";

const button =
  "rounded-full bg-primary-600 px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Card step of a replacement-pricing booking: the booking is accepted and holds its rooms
 * until `payment.expiresAt`; the guest pays the PaymentIntent, then the server confirms. For a
 * request the card is only authorised; the hotel's acceptance charges it. */
export default function ReplacementCardPayment(props: {
  slug: string;
  quoteId: string;
  required: PricingCardPaymentRequired;
  request?: boolean;
  onPaid: (result: PricingCardPaymentResult) => void;
}) {
  return (
    <StripeProvider
      clientSecret={props.required.payment.clientSecret}
      stripeAccountId={props.required.payment.stripeAccountId}
    >
      <CardForm {...props} />
    </StripeProvider>
  );
}

function CardForm({
  slug,
  quoteId,
  required,
  request = false,
  onPaid,
}: {
  slug: string;
  quoteId: string;
  required: PricingCardPaymentRequired;
  request?: boolean;
  onPaid: (result: PricingCardPaymentResult) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);

  async function confirmWithServer() {
    // Stripe can report the payment a moment after the browser sees it succeed.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await completePricingCardPayment(slug, quoteId, required.requestId);
      } catch (failure) {
        const pending =
          failure instanceof ApiError &&
          failure.status === 409 &&
          (failure.detail as { code?: unknown } | null)?.code === "PAYMENT_PENDING";
        if (!pending || attempt === 5) throw failure;
        await wait(1500);
      }
    }
    throw new Error("unreachable");
  }

  async function pay() {
    if (!stripe || !elements || started.current) return;
    started.current = true;
    setBusy(true);
    setError("");
    try {
      const { error: stripeError } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (stripeError) {
        // A card form that isn't filled in yet isn't a failed payment. Never Stripe's decline
        // code: it says something about the guest's card.
        if (stripeError.type !== "validation_error")
          trackEvent(slug, "booking_error", { step: "payment", reason: "payment_failed" });
        setError(stripeError.message || "The card payment did not go through. Please try again.");
        started.current = false;
        return;
      }
      trackEvent(slug, "payment_authorized", { paymentMethod: "card" });
      onPaid(await confirmWithServer());
    } catch {
      trackEvent(slug, "booking_error", { step: "payment", reason: "booking_uncertain" });
      setError(
        request
          ? "We couldn’t confirm your card authorisation yet. If it went through, we’ll email you when we answer."
          : "We couldn’t confirm your payment yet. If your card was charged, your booking will be confirmed by email.",
      );
      started.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Card payment" className="space-y-4 rounded-xl border p-5">
      <h3 className="text-lg font-semibold">{request ? "Authorise your card" : "Pay by card"}</h3>
      {request && (
        <p className="text-sm">
          Your card is authorised now and charged only if we accept your request. We answer within
          24 hours.
        </p>
      )}
      <p className="text-sm text-gray-600">
        Your rooms are held until{" "}
        {new Date(deviceTimeOf(required.payment.expiresAt)).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })}
        . Booking reference {required.bookingReference}.
      </p>
      <PaymentElement />
      {error && <p role="alert">{error}</p>}
      <button className={button} type="button" onClick={pay} disabled={!stripe || busy}>
        {busy
          ? request
            ? "Authorising…"
            : "Paying…"
          : request
            ? "Authorise card and send request"
            : "Pay and confirm booking"}
      </button>
    </section>
  );
}
