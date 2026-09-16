"use client";

import { useState, type FormEvent } from "react";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { ApiError } from "@/services/api/client";
import {
  acceptPricingQuote,
  type PricingAcceptanceGuest,
  type PricingAcceptanceResult,
} from "@/services/api/pricingAcceptance";

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
  const [result, setResult] = useState<PricingAcceptanceResult | null>(null);
  const [pending, setPending] = useState<{
    guest: PricingAcceptanceGuest;
    disclosure: PublicQuoteGuestDisclosure;
  } | null>(null);
  const supported =
    quote.acceptanceMode === "instant" &&
    quote.paymentMethod === "pay_at_property" &&
    quote.dueNowMinor === "0" &&
    quote.dueLaterMinor === quote.totalMinor;
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
      setResult(
        await acceptPricingQuote(
          slug,
          quote,
          acceptedDisclosure,
          guest,
          undefined,
          pending ? "uncertain-retry" : "fresh",
        ),
      );
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409;
      setRefreshRequired(conflict);
      setError(
        conflict
          ? "This price is no longer available. Get a new price and review its terms again."
          : "We couldn’t confirm your booking. Your room may still have been booked, so retry with the same details.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (result)
    return (
      <section role="status" className="space-y-2 rounded-xl border border-green-300 p-5">
        <h2 className="text-xl font-semibold">Booking confirmed</h2>
        <p>Your booking reference is {result.bookingReference}.</p>
        <p>We sent the confirmation details to the email address you provided.</p>
      </section>
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
        {loading ? "Confirming booking…" : "Confirm booking"}
      </button>
    </form>
  );
}
