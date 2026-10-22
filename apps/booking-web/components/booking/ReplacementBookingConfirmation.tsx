"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import {
  isManualPricingPaymentMethod,
  type PublicBookingQuote,
  type PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { ApiError } from "@/services/api/client";
import type { FunnelPaymentMethod } from "@vayada/domain-booking/conversion-funnel";
import { funnelErrorCode, trackEvent } from "@/services/api/tracking";
import {
  acceptPricingQuote,
  pricingQuoteBookableOnline,
  type PricingAcceptanceGuest,
  type PricingAcceptanceResult,
  type PricingCardPaymentRequired,
  type PricingCardPaymentResult,
  type PricingManualPaymentPending,
} from "@/services/api/pricingAcceptance";
import { displayQuoteMoney } from "@/services/api/replacementOffers";
import ReplacementCardPayment from "./ReplacementCardPayment";

const button = "rounded-full bg-primary-600 px-5 py-3 font-semibold text-white disabled:opacity-40";

/** A booking attempt whose outcome isn't known yet: the quote, details and rules it sent. */
export type BookingAttempt = {
  quoteId: string;
  guest: PricingAcceptanceGuest;
  disclosure: PublicQuoteGuestDisclosure;
};

export default function ReplacementBookingConfirmation({
  slug,
  quote,
  disclosure,
  guest,
  termsAccepted,
  hotelTerms = false,
  attempt: heldAttempt,
  onAttemptChange,
  onBooked,
  onConsentMissing,
}: {
  slug: string;
  quote: PublicBookingQuote;
  disclosure: PublicQuoteGuestDisclosure | null;
  /** The guest's details from the details step (VAY-2195); null until they are complete. */
  guest: PricingAcceptanceGuest | null;
  termsAccepted: boolean;
  /** The hotel has its own Terms & Conditions on this page (VAY-2176). */
  hotelTerms?: boolean;
  /** The page keeps the open attempt (VAY-2195), so leaving and coming back to this step can't
   * lose it: a retry then sends the same details as an uncertain retry. */
  attempt?: BookingAttempt | null;
  onAttemptChange?: (attempt: BookingAttempt | null) => void;
  /** The booking (or request, or bank-transfer/PayPal reservation) is made: the page moves on to
   * its confirmation (VAY-2195). */
  onBooked?: (booking: {
    bookingReference: string;
    requested: boolean;
    confirmationUrl?: string;
  }) => void;
  /** The page can point at the boxes still to tick (VAY-2306): Confirm then stays pressable and
   * a press before both are ticked calls this instead of booking. */
  onConsentMissing?: () => void;
}) {
  const termsNoticeId = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [result, setResult] = useState<PricingAcceptanceResult | PricingCardPaymentResult | null>(
    null,
  );
  const [cardPayment, setCardPayment] = useState<PricingCardPaymentRequired | null>(null);
  const [manualPayment, setManualPayment] = useState<PricingManualPaymentPending | null>(null);
  const [ownAttempt, setOwnAttempt] = useState<BookingAttempt | null>(null);
  const held = onAttemptChange !== undefined;
  const open = held ? heldAttempt : ownAttempt;
  const pending = open?.quoteId === quote.quoteId ? open : null;
  const setPending = (value: BookingAttempt | null) =>
    held ? onAttemptChange(value) : setOwnAttempt(value);
  const supported = pricingQuoteBookableOnline(quote);
  // The funnel's name for it; the event allowlist drops any other value (VAY-2197).
  const funnelMethod = quote.paymentMethod as FunnelPaymentMethod;
  // A request-mode hotel confirms each booking itself; nothing is charged when the guest asks.
  // Bank transfer and PayPal wait for the payment instead, in either mode.
  const request =
    quote.acceptanceMode === "request" && !isManualPricingPaymentMethod(quote.paymentMethod);
  const consented = termsAccepted && disclosure?.quoteId === quote.quoteId;
  const ready = supported && !refreshRequired && (!!pending || (!!guest && consented));
  const consentMissing =
    !!onConsentMissing && supported && !refreshRequired && !pending && !!guest && !consented;
  useEffect(() => {
    if (!result) return;
    const requested = result.kind === "requested" || (result.kind === "replayed" && request);
    trackEvent(slug, "booking_completed", {
      paymentMethod: funnelMethod,
      outcome: requested ? "requested" : "confirmed",
    });
    onBooked?.({ bookingReference: result.bookingReference, requested });
    // Once per booking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  useEffect(() => {
    if (!manualPayment) return;
    trackEvent(slug, "booking_completed", {
      paymentMethod: funnelMethod,
      outcome: "awaiting_payment",
    });
    onBooked?.({
      bookingReference: manualPayment.bookingReference,
      requested: false,
      confirmationUrl: `/confirmation?${new URLSearchParams({
        booking: manualPayment.bookingReference,
        token: manualPayment.confirmationToken,
      })}`,
    });
    // Once per reservation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualPayment]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (consentMissing) return onConsentMissing?.();
    const acceptedDisclosure = pending?.disclosure ?? disclosure;
    const attempted = pending?.guest ?? guest;
    if (!ready || !acceptedDisclosure || !attempted || loading || result) return;
    // A retry of an attempt whose outcome isn't known is the same click.
    if (!pending)
      trackEvent(slug, "complete_booking_clicked", {
        paymentMethod: funnelMethod,
        mode: request ? "request" : "instant",
      });
    setPending({ quoteId: quote.quoteId, guest: attempted, disclosure: acceptedDisclosure });
    setLoading(true);
    setError("");
    try {
      const accepted = await acceptPricingQuote(
        slug,
        quote,
        acceptedDisclosure,
        attempted,
        undefined,
        pending ? "uncertain-retry" : "fresh",
      );
      if (accepted.kind === "payment_required") setCardPayment(accepted);
      else if (accepted.kind === "payment_pending") setManualPayment(accepted);
      else setResult(accepted);
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409;
      // 404 on a first attempt: online booking is off or this hotel is not bookable, so nothing
      // was stored. A retry after an uncertain attempt keeps the uncertain message.
      const unavailable = failure instanceof ApiError && failure.status === 404 && !pending;
      const code =
        failure instanceof ApiError && (failure.detail as { code?: unknown } | null)?.code;
      const cardUnavailable = unavailable && code === "CARD_PAYMENT_UNAVAILABLE";
      // The hotel confirms each booking, but online requests are not switched on yet.
      const requestUnavailable = unavailable && code === "REQUEST_ACCEPTANCE_UNAVAILABLE";
      // Bank transfer and PayPal on the booking page are not switched on (VAY-2139).
      const manualUnavailable = unavailable && code === "MANUAL_PAYMENT_UNAVAILABLE";
      // Nothing was stored and a retry can't succeed, so only a new price can continue.
      setRefreshRequired(conflict || unavailable);
      // Nothing was stored: the attempt is over and only a new price can continue.
      if (conflict || unavailable) setPending(null);
      trackEvent(slug, "booking_error", {
        step: "payment",
        reason: conflict
          ? "price_expired"
          : unavailable
            ? "booking_unavailable"
            : "booking_uncertain",
        code: funnelErrorCode(code),
      });
      setError(
        conflict
          ? "This price is no longer available. Get a new price and review its terms again."
          : requestUnavailable
            ? "We confirm each booking ourselves, and booking requests can’t be sent online yet. No room was reserved and no payment was taken."
            : cardUnavailable
              ? "Paying by card online isn’t available right now. Get a new price with “Pay at the hotel”. No room was reserved and no payment was taken."
              : manualUnavailable
                ? "Paying by bank transfer or PayPal isn’t available right now. Get a new price with another payment method. No room was reserved."
                : unavailable
                  ? "Online booking is not available for this hotel right now. No room was reserved and no payment was taken."
                  : request
                    ? "We couldn’t confirm your request was sent. It may still have reached us, so retry with the same details."
                    : "We couldn’t confirm your booking. Your room may still have been booked, so retry with the same details.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (manualPayment) {
    const { method, amountMinor, currency, deadlineAt } = manualPayment.payment;
    const details = new URLSearchParams({
      booking: manualPayment.bookingReference,
      token: manualPayment.confirmationToken,
    });
    return (
      <section role="status" className="space-y-2 rounded-xl border border-green-300 p-5">
        <h2 className="text-xl font-semibold">Your room is reserved</h2>
        <p>Your booking reference is {manualPayment.bookingReference}.</p>
        <p>
          Please pay {displayQuoteMoney(amountMinor, currency)} by{" "}
          {method === "paypal" ? "PayPal" : "bank transfer"} by{" "}
          {new Date(deadlineAt).toLocaleString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZoneName: "short",
          })}
          . We’ll confirm your booking when your payment arrives. If it doesn’t arrive by then, the
          booking expires and the room is released.
        </p>
        <p>We sent the payment details to the email address you provided.</p>
        <a className={`${button} inline-block`} href={`/confirmation?${details}`}>
          See payment details
        </a>
      </section>
    );
  }

  if (result && (result.kind === "requested" || (result.kind === "replayed" && request)))
    return (
      <section role="status" className="space-y-2 rounded-xl border border-green-300 p-5">
        <h2 className="text-xl font-semibold">Booking request sent</h2>
        <p>Your request reference is {result.bookingReference}.</p>
        <p>
          {quote.paymentMethod === "card"
            ? "We’ll accept or decline your request within 24 hours. Your card is authorised but not charged; it is charged only if we accept."
            : "We’ll accept or decline your request within 24 hours. Nothing has been charged, and your stay is not confirmed until we accept."}
        </p>
        <p>We sent the request details to the email address you provided.</p>
      </section>
    );

  if (result)
    return (
      <section role="status" className="space-y-2 rounded-xl border border-green-300 p-5">
        <h2 className="text-xl font-semibold">Booking confirmed</h2>
        <p>Your booking reference is {result.bookingReference}.</p>
        <p>We sent the confirmation details to the email address you provided.</p>
      </section>
    );

  if (cardPayment)
    return (
      <ReplacementCardPayment
        slug={slug}
        quoteId={quote.quoteId}
        required={cardPayment}
        request={request}
        onPaid={setResult}
      />
    );

  return (
    <form className="space-y-4" onSubmit={submit}>
      {!supported ? (
        <p role="status">Online confirmation is not available for this payment option.</p>
      ) : !ready && !refreshRequired && !consentMissing ? (
        <p role="status">
          {guest
            ? "Read and accept both the room terms and guest rules to book."
            : "Fill in your details to book."}
        </p>
      ) : null}
      {error && <p role="alert">{error}</p>}
      {hotelTerms && (
        <p id={termsNoticeId} className="text-sm text-gray-600">
          By booking, you agree to our terms & conditions.
        </p>
      )}
      <button
        className={button}
        type="submit"
        disabled={!(ready || consentMissing) || loading}
        aria-describedby={hotelTerms ? termsNoticeId : undefined}
      >
        {loading
          ? request
            ? "Sending request…"
            : "Confirming booking…"
          : quote.paymentMethod === "card"
            ? request
              ? "Continue to card authorisation"
              : "Continue to card payment"
            : request
              ? "Send booking request"
              : "Confirm booking"}
      </button>
    </form>
  );
}
