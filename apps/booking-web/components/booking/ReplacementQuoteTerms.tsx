"use client";

import { useEffect, useId, useState } from "react";
import {
  isManualPricingPaymentMethod,
  type PublicBookingQuote,
} from "@vayada/domain-booking/replacement-pricing";
import { serverNow } from "@/lib/serverClock";
import { bookingPagePaymentMethodLabels } from "@/services/api/bookingPagePaymentMethods";
import ConsentTile from "./ConsentTile";

export type QuoteTermsAcknowledgement = { quoteId: string; termsIdentity: string };
export type ReplacementQuoteTermsProps = {
  quote: PublicBookingQuote;
  roomNames: Readonly<Record<string, string>>;
  stale?: boolean;
  onAcknowledgementChange?: (value: QuoteTermsAcknowledgement | null) => void;
  /** The payment step's short form (VAY-2195): the tick first, the terms behind "Read". */
  compact?: boolean;
  /** Confirm was pressed before ticking (VAY-2306): the id of the message that says so. */
  errorId?: string;
};
const mealNames: Record<string, string> = {
  room_only: "Room only (no meals)",
  breakfast: "Breakfast",
  half_board: "Half board",
  full_board: "Full board",
  all_inclusive: "All inclusive",
};
const methodNames: Record<string, string> = bookingPagePaymentMethodLabels;

/** The caller supplies a validated quote and retires it when the selection becomes stale. */
export default function ReplacementQuoteTerms({
  quote,
  roomNames,
  stale = false,
  onAcknowledgementChange,
  compact = false,
  errorId,
}: ReplacementQuoteTermsProps) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const identity = JSON.stringify([
    { ...quote, replayed: undefined },
    quote.rooms.map((room) => roomNames[room.selectionId] ?? null),
  ]);
  const [acknowledgedIdentity, setAcknowledgedIdentity] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  // Judged on the server's clock: a device clock that is behind or ahead must not block a valid
  // quote (VAY-2134).
  const expiresAt = Date.parse(quote.expiresAt);
  const unavailable = stale || expired || expiresAt <= serverNow();
  const missingLabels = quote.rooms.some((room) => !roomNames[room.selectionId]?.trim());
  const agreed = !unavailable && !missingLabels && acknowledgedIdentity === identity;

  useEffect(() => {
    setAcknowledgedIdentity(null);
    setExpired(expiresAt <= serverNow());
    const timer = setTimeout(
      () => {
        setExpired(true);
        setAcknowledgedIdentity(null);
      },
      Math.max(0, expiresAt - serverNow()),
    );
    return () => clearTimeout(timer);
  }, [identity, stale, expiresAt]);

  useEffect(() => {
    onAcknowledgementChange?.(agreed ? { quoteId: quote.quoteId, termsIdentity: identity } : null);
    return () => onAcknowledgementChange?.(null);
  }, [agreed, identity, quote.quoteId, onAcknowledgementChange]);

  const status = (unavailable || missingLabels) && (
    <p role="status">
      {unavailable
        ? "This price is no longer current. Get an updated price to review and acknowledge its terms."
        : "Room details are unavailable. Refresh your room selection before acknowledging these terms."}
    </p>
  );
  const acknowledge = (checked: boolean) =>
    setAcknowledgedIdentity(checked && expiresAt > serverNow() ? identity : null);
  const tick = (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0"
        checked={agreed}
        disabled={unavailable || missingLabels}
        onChange={(event) => acknowledge(event.target.checked)}
      />
      <span>I have read the room and rate terms for this price preview.</span>
    </label>
  );
  const terms = (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-xl border border-gray-200 p-5"
    >
      <h2 id={headingId} className="text-xl font-semibold">
        Your room and rate terms
      </h2>
      <p>
        For your stay from {quote.checkIn} to {quote.checkOut}.
      </p>
      {quote.rooms.map((room, index) => (
        <section
          key={room.selectionId}
          aria-label={`Room ${index + 1} terms`}
          className="space-y-2 border-t pt-3"
        >
          <h3 className="font-semibold">
            Room {index + 1}: {roomNames[room.selectionId] || "Room name unavailable"}
          </h3>
          <p>Meals: {mealNames[room.mealPlan]}</p>
          <h4 className="font-medium">Cancellation</h4>
          {room.cancellation.kind === "non_refundable" ? (
            <p>Non-refundable.</p>
          ) : (
            <div className="space-y-2">
              <p>
                Cancellation type:{" "}
                {room.cancellation.terms.flexibleCancellationType === "partial_refund"
                  ? "Partial refund"
                  : "Flexible"}
                .
              </p>
              {room.cancellation.terms.flexibleCancellationType === "partial_refund" ? (
                // The refund steps alone decide (VAY-2100); there is no separate free deadline.
                <PartialRefundSteps tiers={room.cancellation.terms.partialRefundTiers ?? []} />
              ) : (
                <>
                  <p>
                    Free cancellation deadline:{" "}
                    {room.cancellation.terms.freeCancellationDeadlineDays} days before arrival.
                  </p>
                  <p>After-deadline penalty: full booking amount.</p>
                </>
              )}
              <p>No-show penalty: full booking amount.</p>
              {room.cancellation.terms.text && (
                <p className="whitespace-pre-wrap break-words">{room.cancellation.terms.text}</p>
              )}
            </div>
          )}
          <h4 className="font-medium">Payment</h4>
          <p>
            {room.payment.kind === "deposit"
              ? `Payment terms: ${room.payment.basisPoints / 100}% when booking, the rest at the property.`
              : "Payment terms: full payment."}
          </p>
          <p>
            Accepted methods:{" "}
            {room.payment.acceptedMethods?.map((method) => methodNames[method]).join(", ")}.
          </p>
        </section>
      ))}
      <div className="space-y-1">
        <h3 className="font-semibold">Booking confirmation</h3>
        <p>
          {isManualPricingPaymentMethod(quote.paymentMethod)
            ? "We hold your room until the payment deadline and confirm your booking when your payment arrives."
            : quote.acceptanceMode === "request"
              ? "Your booking will need our approval. Sending a request does not confirm your stay."
              : "Your booking will be confirmed when you complete the booking process. No separate approval from us is needed."}
        </p>
      </div>
      <p>Selected payment method: {methodNames[quote.paymentMethod]}.</p>
      {!compact && (
        <p className="text-sm text-gray-600">
          This price preview does not reserve a room or take payment. These are rate terms only.
          Please also review our guest rules before booking.
        </p>
      )}
      {!compact && status}
      {!compact && tick}
    </section>
  );
  if (!compact) return terms;
  return (
    <div className="space-y-2">
      {status && <div className="text-sm text-gray-600">{status}</div>}
      <ConsentTile
        label="I have read the room and rate terms for this price."
        checked={agreed}
        disabled={unavailable || missingLabels}
        errorId={errorId}
        onChange={acknowledge}
      >
        <button
          type="button"
          className="inline-flex min-h-6 items-center text-[13px] font-medium text-primary-600 underline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide the room and rate terms" : "Read the room and rate terms"}
        </button>
      </ConsentTile>
      {open && terms}
    </div>
  );
}

/** Most notice first; with less notice than the last step, nothing is refunded. */
function PartialRefundSteps({
  tiers,
}: {
  tiers: readonly { minDaysBeforeCheckIn: number; refundPercent: number }[];
}) {
  const steps = [...tiers].sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn);
  const last = steps.at(-1);
  return (
    <>
      <ul className="list-disc pl-5" aria-label="Refund notice periods">
        {steps.map((tier) => (
          <li key={tier.minDaysBeforeCheckIn}>
            {tier.refundPercent}% refund with at least {tier.minDaysBeforeCheckIn} days before
            check-in.
          </li>
        ))}
      </ul>
      {last && last.minDaysBeforeCheckIn > 0 && (
        <p>No refund with less than {last.minDaysBeforeCheckIn} days before check-in.</p>
      )}
    </>
  );
}
