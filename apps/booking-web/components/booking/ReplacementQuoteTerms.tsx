"use client";

import { useEffect, useId, useState } from "react";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";

export type QuoteTermsAcknowledgement = { quoteId: string; termsIdentity: string };
export type ReplacementQuoteTermsProps = {
  quote: PublicBookingQuote;
  roomNames: Readonly<Record<string, string>>;
  stale?: boolean;
  onAcknowledgementChange?: (value: QuoteTermsAcknowledgement | null) => void;
};
const mealNames: Record<string, string> = {
  room_only: "Room only (no meals)",
  breakfast: "Breakfast",
  half_board: "Half board",
  full_board: "Full board",
  all_inclusive: "All inclusive",
};
const methodNames: Record<string, string> = { card: "Card", pay_at_property: "Pay at property" };

/** The caller supplies a validated quote and retires it when the selection becomes stale. */
export default function ReplacementQuoteTerms({
  quote,
  roomNames,
  stale = false,
  onAcknowledgementChange,
}: ReplacementQuoteTermsProps) {
  const headingId = useId();
  const identity = JSON.stringify([
    { ...quote, replayed: undefined },
    quote.rooms.map((room) => roomNames[room.selectionId] ?? null),
  ]);
  const [acknowledgedIdentity, setAcknowledgedIdentity] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const issuedAt = Date.parse(quote.issuedAt);
  const expiresAt = Date.parse(quote.expiresAt);
  const unavailable = stale || expired || issuedAt > Date.now() || expiresAt <= Date.now();
  const missingLabels = quote.rooms.some((room) => !roomNames[room.selectionId]?.trim());
  const agreed = !unavailable && !missingLabels && acknowledgedIdentity === identity;

  useEffect(() => {
    setAcknowledgedIdentity(null);
    setExpired(expiresAt <= Date.now());
    const timer = setTimeout(
      () => {
        setExpired(true);
        setAcknowledgedIdentity(null);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [identity, stale, expiresAt]);

  useEffect(() => {
    onAcknowledgementChange?.(agreed ? { quoteId: quote.quoteId, termsIdentity: identity } : null);
    return () => onAcknowledgementChange?.(null);
  }, [agreed, identity, quote.quoteId, onAcknowledgementChange]);

  return (
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
              <p>
                Free cancellation deadline: {room.cancellation.terms.freeCancellationDeadlineDays}{" "}
                days before arrival.
              </p>
              <p>After-deadline penalty: full booking amount.</p>
              <p>No-show penalty: full booking amount.</p>
              {room.cancellation.terms.partialRefundCancelWindowDays !== undefined && (
                <p>
                  Partial refund cancellation window:{" "}
                  {room.cancellation.terms.partialRefundCancelWindowDays} days before check-in.
                </p>
              )}
              {room.cancellation.terms.partialRefundAmountPercent !== undefined && (
                <p>Partial refund amount: {room.cancellation.terms.partialRefundAmountPercent}%.</p>
              )}
              {!!room.cancellation.terms.partialRefundTiers?.length && (
                <ul className="list-disc pl-5" aria-label="Refund notice periods">
                  {room.cancellation.terms.partialRefundTiers.map((tier) => (
                    <li key={tier.minDaysBeforeCheckIn}>
                      {tier.refundPercent}% refund with at least {tier.minDaysBeforeCheckIn} days
                      before check-in.
                    </li>
                  ))}
                </ul>
              )}
              {room.cancellation.terms.text && (
                <p className="whitespace-pre-wrap break-words">{room.cancellation.terms.text}</p>
              )}
            </div>
          )}
          <h4 className="font-medium">Payment</h4>
          <p>Payment terms: full payment.</p>
          <p>
            Accepted methods:{" "}
            {room.payment.acceptedMethods?.map((method) => methodNames[method]).join(", ")}.
          </p>
        </section>
      ))}
      <p>Selected payment method: {methodNames[quote.paymentMethod]}.</p>
      <p className="text-sm text-gray-600">
        This price preview does not reserve a room or take payment. These are rate terms only; our
        guest policies still need to be provided before a booking can be submitted.
      </p>
      {(unavailable || missingLabels) && (
        <p role="status">
          {unavailable
            ? "This price is no longer current. Get an updated price to review and acknowledge its terms."
            : "Room details are unavailable. Refresh your room selection before acknowledging these terms."}
        </p>
      )}
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 shrink-0"
          checked={agreed}
          disabled={unavailable || missingLabels}
          onChange={(event) =>
            setAcknowledgedIdentity(
              event.target.checked && expiresAt > Date.now() ? identity : null,
            )
          }
        />
        <span>I have read the room and rate terms for this price preview.</span>
      </label>
    </section>
  );
}
