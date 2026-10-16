"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import BookingPageTerms from "./BookingPageTerms";
import {
  isManualPricingPaymentMethod,
  type PricingPaymentMethod,
  type PublicBookingQuote,
} from "@vayada/domain-booking/replacement-pricing";

const cardIcon =
  "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z";
const hotelIcon =
  "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4";
const bankIcon = "M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18";
const icon = (d: string, size = "w-5 h-5 text-gray-700") => (
  <svg className={size} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
);

const methods: Record<PricingPaymentMethod, { title: string; note: string; icon: string }> = {
  pay_at_property: {
    title: "Pay at the hotel",
    note: "Pay when you arrive. Nothing to pay now.",
    icon: hotelIcon,
  },
  card: { title: "Pay by card now", note: "Pay securely online now.", icon: cardIcon },
  bank_transfer: {
    title: "Bank transfer",
    note: "Transfer the amount to our bank account.",
    icon: bankIcon,
  },
  paypal: { title: "PayPal", note: "Send the amount to us by PayPal.", icon: cardIcon },
};

/** What happens with the chosen way to pay, in the old info box (VAY-2195). */
function explanation(
  method: PricingPaymentMethod,
  quote: PublicBookingQuote | undefined,
  total: string,
) {
  const request = quote?.acceptanceMode === "request";
  if (isManualPricingPaymentMethod(method))
    return "We hold your room until the payment deadline and confirm your booking when your payment arrives.";
  if (method === "card")
    return request
      ? `We authorise ${total} on your card now and charge it only if we accept your request. We answer within 24 hours.`
      : `We charge ${total} to your card when you confirm. Your booking is confirmed straight away.`;
  return request
    ? `Nothing is charged now. You pay ${total} at the hotel if we accept your request. We answer within 24 hours.`
    : `Nothing is charged now. You pay ${total} at the hotel when you arrive. Your booking is confirmed straight away.`;
}

const card = "bg-white rounded-2xl border border-gray-200 p-6";

/** The old secure-payment page on pricing v2 (VAY-2195): who is booking, how they pay, what they
 * agree to for this final price, and the button that books. */
export default function PaymentStep({
  guestName,
  guestEmail,
  onChangeDetails,
  method,
  available,
  tooSoon,
  onMethod,
  quote,
  total,
  notice,
  acknowledgements,
  cancellation,
  confirm,
  onBack,
  locked = false,
  termsText = null,
}: {
  guestName: string;
  guestEmail: string;
  onChangeDetails: () => void;
  method: PricingPaymentMethod | "";
  available: PricingPaymentMethod[];
  tooSoon: string | null;
  onMethod: (method: PricingPaymentMethod) => void;
  quote: PublicBookingQuote | undefined;
  /** The quote's total as the guest reads it, or "" while it loads. */
  total: string;
  notice: ReactNode;
  acknowledgements: ReactNode;
  cancellation: string[];
  confirm: ReactNode;
  onBack: () => void;
  /** A booking attempt is open: the way to pay and the details can't change until it settles. */
  locked?: boolean;
  /** Our terms & conditions, readable here where booking accepts them (VAY-2176). */
  termsText?: string | null;
}) {
  const [showTerms, setShowTerms] = useState(false);
  // The options behave like radio buttons: arrow keys move the choice.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step || locked || !available.length) return;
    event.preventDefault();
    const index = Math.max(0, available.indexOf(method as PricingPaymentMethod));
    const target = available[(index + step + available.length) % available.length]!;
    onMethod(target);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-method="${target}"]`)?.focus();
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-bold text-gray-900">{guestName}</p>
          <p className="text-sm text-gray-500">{guestEmail}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="flex items-center gap-1.5 text-primary-600 font-medium">
            {icon("M5 13l4 4L19 7", "w-4 h-4")}
            Details confirmed
          </span>
          <button
            type="button"
            className="text-gray-500 underline disabled:opacity-40"
            disabled={locked}
            onClick={onChangeDetails}
          >
            Change
          </button>
        </div>
      </div>
      {notice}
      <section aria-label="How would you like to pay?" className={card}>
        <div className="flex items-center gap-2.5 mb-6">
          {icon(cardIcon)}
          <h2 className="text-lg font-bold text-gray-900">How would you like to pay?</h2>
        </div>
        <div
          role="radiogroup"
          aria-label="Payment preference"
          aria-disabled={locked || undefined}
          className="space-y-3 mb-6"
          onKeyDown={onKeyDown}
        >
          {available.map((value) => {
            const on = value === method;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                data-method={value}
                tabIndex={on || (!method && value === available[0]) ? 0 : -1}
                disabled={locked}
                onClick={() => onMethod(value)}
                className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                  on ? "border-primary-600 bg-primary-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${on ? "border-primary-600" : "border-gray-300"}`}
                  >
                    {on && <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      {icon(methods[value].icon)}
                      <span className="font-semibold text-sm text-gray-900">
                        {methods[value].title}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 ml-7">{methods[value].note}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        {tooSoon && <p className="mb-4 text-sm text-gray-600">{tooSoon}</p>}
        {method && total && (
          <div className="p-4 bg-primary-50 border border-primary-100 rounded-xl text-sm text-primary-700">
            {explanation(method, quote, total)}
          </div>
        )}
        {method === "card" && (
          <div className="mt-3 p-3 bg-gray-100 rounded-lg text-sm text-gray-600 flex items-center gap-2">
            {icon(cardIcon, "w-4 h-4 text-gray-400")}
            You enter your card details in the next step.
          </div>
        )}
      </section>
      {/* What the guest agrees to belongs to a price: without one there is nothing to accept. */}
      {quote && (
        <section aria-label="Before you book" className={`${card} space-y-4`}>
          <h2 className="text-base font-bold text-gray-900">Before you book</h2>
          {acknowledgements}
          {termsText && (
            <div className="space-y-2">
              <button
                type="button"
                className="text-xs font-medium text-primary-600 underline"
                aria-expanded={showTerms}
                onClick={() => setShowTerms((value) => !value)}
              >
                {showTerms ? "Hide our terms & conditions" : "Read our terms & conditions"}
              </button>
              {showTerms && <BookingPageTerms text={termsText} />}
            </div>
          )}
        </section>
      )}
      {cancellation.length > 0 && (
        <section aria-label="Cancellation" className={card}>
          <h2 className="text-base font-bold text-gray-900 mb-2">Cancellation</h2>
          {cancellation.map((line) => (
            <p key={line} className="text-sm text-gray-600">
              {line}
            </p>
          ))}
        </section>
      )}
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          disabled={locked}
          className="px-5 py-2.5 rounded-full border border-gray-300 text-sm font-medium text-gray-700 flex items-center gap-1.5 disabled:opacity-40"
        >
          {icon("M15 19l-7-7 7-7", "w-4 h-4")}
          Back to your details
        </button>
        {confirm}
      </div>
    </div>
  );
}
