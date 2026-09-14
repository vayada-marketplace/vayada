"use client";
import { useEffect, useState } from "react";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { getQuoteGuestDisclosure } from "@/services/api/quoteGuestDisclosure";

export default function ReplacementGuestRules({
  slug,
  quote,
}: {
  slug: string;
  quote: PublicBookingQuote;
}) {
  const [disclosure, setDisclosure] = useState<PublicQuoteGuestDisclosure | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const identity = JSON.stringify([slug, quote.quoteId, quote.issuedAt, quote.expiresAt]);
  useEffect(() => {
    const controller = new AbortController();
    setDisclosure(null);
    setError(false);
    setAcknowledged(null);
    void getQuoteGuestDisclosure(slug, quote, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDisclosure(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
    // The quote ID identifies immutable evidence; dates prevent reusing malformed replacements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, retry]);
  if (error)
    return (
      <p role="alert">
        We couldn’t verify our guest rules for this price.{" "}
        <button className="underline" onClick={() => setRetry((value) => value + 1)}>
          Retry guest rules
        </button>
      </p>
    );
  if (!disclosure) return <p role="status">Loading guest rules…</p>;
  const rules = disclosure.choices;
  const current =
    disclosure.quoteId === quote.quoteId && Date.parse(disclosure.expiresAt) > Date.now();
  const consent = JSON.stringify([
    identity,
    disclosure.quoteEvidenceId,
    disclosure.guestPolicyEvidenceId,
  ]);
  return (
    <section aria-label="Guest rules" className="rounded-xl border border-gray-200 p-5 space-y-3">
      <h2 className="text-xl font-semibold">Our guest rules</h2>
      <p>Times are in {disclosure.propertyTimeZone}.</p>
      <p>
        Check-in from {rules.checkInTime}
        {rules.checkInUntil
          ? ` until ${rules.checkInUntil === "00:00" ? "midnight at the end of your arrival day" : rules.checkInUntil}`
          : ""}
        .
      </p>
      <p>
        Check-out {rules.checkOutFrom ? `from ${rules.checkOutFrom} ` : ""}by {rules.checkOutTime}.
      </p>
      <p>
        {rules.childrenEnabled ? "Children are welcome." : "We do not accommodate children."}
        {rules.adultAgeThreshold !== null
          ? ` Our adult age threshold is ${rules.adultAgeThreshold}.`
          : ""}
      </p>
      <p>
        {rules.phoneRequired
          ? "A phone number is required when booking."
          : "A phone number is optional when booking."}
      </p>
      <p>
        {rules.arrivalTimeEnabled
          ? "You can provide your expected arrival time."
          : "We do not collect an expected arrival time online."}
      </p>
      <p>
        {rules.specialRequestsEnabled
          ? "You can include special requests when booking."
          : "Special requests cannot be submitted online."}
      </p>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={current && acknowledged === consent}
          disabled={!current}
          onChange={(event) =>
            setAcknowledged(
              event.target.checked && Date.parse(disclosure.expiresAt) > Date.now()
                ? consent
                : null,
            )
          }
        />
        I have read the guest rules for this price preview.
      </label>
    </section>
  );
}
