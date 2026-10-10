"use client";

import { useState, type FormEvent } from "react";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { ApiError } from "@/services/api/client";
import {
  acceptPricingQuote,
  pricingQuoteBookableOnline,
  type PricingAcceptanceGuest,
  type PricingAcceptanceResult,
  type PricingCardPaymentRequired,
  type PricingCardPaymentResult,
} from "@/services/api/pricingAcceptance";
import ReplacementCardPayment from "./ReplacementCardPayment";

const field = "mt-1 block w-full rounded-lg border border-gray-300 bg-white p-3 text-gray-900";
const button = "rounded-full bg-primary-600 px-5 py-3 font-semibold text-white disabled:opacity-40";

export default function ReplacementBookingConfirmation({
  slug,
  quote,
  disclosure,
  termsAccepted,
}: {
  slug: string;
  quote: PublicBookingQuote;
  disclosure: PublicQuoteGuestDisclosure | null;
  termsAccepted: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [result, setResult] = useState<PricingAcceptanceResult | PricingCardPaymentResult | null>(
    null,
  );
  const [cardPayment, setCardPayment] = useState<PricingCardPaymentRequired | null>(null);
  const [pending, setPending] = useState<{
    guest: PricingAcceptanceGuest;
    disclosure: PublicQuoteGuestDisclosure;
  } | null>(null);
  const supported = pricingQuoteBookableOnline(quote);
  // A request-mode hotel confirms each booking itself; nothing is charged when the guest asks.
  const request = quote.acceptanceMode === "request";
  const ready =
    supported &&
    !refreshRequired &&
    (!!pending || (termsAccepted && disclosure?.quoteId === quote.quoteId));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const acceptedDisclosure = pending?.disclosure ?? disclosure;
    if (!ready || !acceptedDisclosure || loading || result) return;
    const data = new FormData(event.currentTarget);
    const guest =
      pending?.guest ??
      ({
        firstName: String(data.get("firstName") ?? ""),
        lastName: String(data.get("lastName") ?? ""),
        email: String(data.get("email") ?? ""),
        phone: String(data.get("phone") ?? ""),
        countryCode: String(data.get("countryCode") ?? ""),
        arrivalTime: String(data.get("arrivalTime") ?? ""),
        specialRequests: String(data.get("specialRequests") ?? ""),
      } satisfies PricingAcceptanceGuest);
    setPending({ guest, disclosure: acceptedDisclosure });
    setLoading(true);
    setError("");
    try {
      const accepted = await acceptPricingQuote(
        slug,
        quote,
        acceptedDisclosure,
        guest,
        undefined,
        pending ? "uncertain-retry" : "fresh",
      );
      if (accepted.kind === "payment_required") setCardPayment(accepted);
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
      setRefreshRequired(conflict || cardUnavailable || requestUnavailable);
      setError(
        conflict
          ? "This price is no longer available. Get a new price and review its terms again."
          : requestUnavailable
            ? "This hotel confirms each booking itself, and booking requests can’t be sent online yet. No room was reserved and no payment was taken."
            : cardUnavailable
              ? "Paying by card online isn’t available right now. Get a new price with “Pay at property”. No room was reserved and no payment was taken."
              : unavailable
                ? "Online booking is not available for this hotel right now. No room was reserved and no payment was taken."
                : request
                  ? "We couldn’t confirm your request was sent. It may still have reached the hotel, so retry with the same details."
                  : "We couldn’t confirm your booking. Your room may still have been booked, so retry with the same details.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (result && (result.kind === "requested" || (result.kind === "replayed" && request)))
    return (
      <section role="status" className="space-y-2 rounded-xl border border-green-300 p-5">
        <h2 className="text-xl font-semibold">Booking request sent</h2>
        <p>Your request reference is {result.bookingReference}.</p>
        <p>
          {quote.paymentMethod === "card"
            ? "The hotel will accept or decline your request within 24 hours. Your card is authorised but not charged; it is charged only if the hotel accepts."
            : "The hotel will accept or decline your request within 24 hours. Nothing has been charged, and your stay is not confirmed until the hotel accepts."}
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

  const policy = disclosure?.choices;
  return (
    <form className="space-y-4 rounded-xl border border-gray-200 p-5" onSubmit={submit}>
      <h2 className="text-xl font-semibold">Your details</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          First name
          <input className={field} name="firstName" maxLength={100} required disabled={!!pending} />
        </label>
        <label>
          Last name
          <input className={field} name="lastName" maxLength={100} required disabled={!!pending} />
        </label>
      </div>
      <label className="block">
        Email
        <input
          className={field}
          name="email"
          type="email"
          maxLength={254}
          required
          disabled={!!pending}
        />
      </label>
      <label className="block">
        Phone {policy?.phoneRequired ? "" : "(optional)"}
        <input
          className={field}
          name="phone"
          type="tel"
          maxLength={64}
          required={policy?.phoneRequired}
          disabled={!!pending}
        />
      </label>
      <label className="block">
        Country code (optional)
        <input
          className={field}
          name="countryCode"
          maxLength={2}
          pattern="[A-Za-z]{2}"
          placeholder="DE"
          disabled={!!pending}
        />
      </label>
      {policy?.arrivalTimeEnabled && (
        <label className="block">
          Expected arrival time (optional)
          <input className={field} name="arrivalTime" type="time" disabled={!!pending} />
        </label>
      )}
      {policy?.specialRequestsEnabled && (
        <label className="block">
          Special requests (optional)
          <textarea
            className={field}
            name="specialRequests"
            maxLength={2000}
            rows={4}
            disabled={!!pending}
          />
        </label>
      )}
      {!supported ? (
        <p role="status">Online confirmation is not available for this payment option.</p>
      ) : !ready && !refreshRequired ? (
        <p role="status">Read and accept both the room terms and guest rules to book.</p>
      ) : null}
      {error && <p role="alert">{error}</p>}
      <button className={button} type="submit" disabled={!ready || loading}>
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
