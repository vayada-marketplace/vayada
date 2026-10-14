"use client";

import Image from "next/image";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import BookingPageTerms from "./BookingPageTerms";
import GuestDetailsForm, { type GuestDetails } from "./GuestDetailsForm";
import type { SummaryRoom } from "./StaySummary";

type Room = PublicBookingQuote["rooms"][number];
const meals: Record<string, string> = {
  room_only: "room only",
  breakfast: "breakfast",
  half_board: "half board",
  full_board: "full board",
  all_inclusive: "all inclusive",
};

/** A room's rate terms in a few plain sentences (VAY-2195); the payment step asks the guest to
 * confirm they read them for the final price. */
export function rateTerms(room: Room): string[] {
  const lines = [`Meals: ${meals[room.mealPlan] ?? room.mealPlan}.`];
  const c = room.cancellation;
  if (c.kind === "non_refundable")
    lines.push(
      "Cancellation: non-refundable. If you cancel, change or don’t arrive, we charge the full amount.",
    );
  else if (c.terms.flexibleCancellationType === "partial_refund") {
    const steps = [...(c.terms.partialRefundTiers ?? [])].sort(
      (a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn,
    );
    lines.push(
      `Cancellation: ${steps
        .map((s) => `${s.refundPercent}% back with at least ${s.minDaysBeforeCheckIn} days’ notice`)
        .join("; ")}. With less notice, or if you don’t arrive, we keep the full amount.`,
    );
  } else
    lines.push(
      `Cancellation: free until ${c.terms.freeCancellationDeadlineDays} days before arrival. After that, or if you don’t arrive, we charge the full amount.`,
    );
  if (c.kind !== "non_refundable" && c.terms.text) lines.push(c.terms.text);
  return lines;
}

/** The hotel's guest rules as sentences (VAY-2195). */
export function ruleLines(d: PublicQuoteGuestDisclosure): [string, string][] {
  const r = d.choices;
  return [
    [
      "Check-in",
      `From ${r.checkInTime}${
        r.checkInUntil
          ? ` until ${r.checkInUntil === "00:00" ? "midnight at the end of your arrival day" : r.checkInUntil}`
          : ""
      }`,
    ],
    ["Check-out", `${r.checkOutFrom ? `From ${r.checkOutFrom}, by` : "By"} ${r.checkOutTime}`],
    [
      "Children",
      `${r.childrenEnabled ? "Children are welcome." : "We do not accommodate children."}${
        r.adultAgeThreshold !== null ? ` Guests from ${r.adultAgeThreshold} count as adults.` : ""
      }`,
    ],
    ["Phone number", r.phoneRequired ? "Required when booking" : "Optional"],
    [
      "Arrival time and requests",
      r.arrivalTimeEnabled && r.specialRequestsEnabled
        ? "You can tell us both below"
        : r.arrivalTimeEnabled
          ? "You can tell us your arrival time"
          : r.specialRequestsEnabled
            ? "You can send us special requests"
            : "We don’t take them online",
    ],
  ];
}

const card = "bg-white rounded-2xl border border-gray-200 p-6";

/** The old guest-information page on pricing v2 (VAY-2195): what the guest is booking, their
 * details, and our guest rules, the room and rate terms and our terms & conditions to read. */
export default function DetailsStep({
  quote,
  rooms,
  stayLine,
  formatMoney,
  guest,
  onGuestChange,
  disclosure,
  rulesFailed,
  onRetryRules,
  termsText,
  locked,
  rules,
}: {
  /** The current price; the form shows without one (a refused price keeps the details). */
  quote: PublicBookingQuote | undefined;
  rooms: SummaryRoom[];
  stayLine: string;
  formatMoney: (minor: string, currency: string) => string;
  guest: GuestDetails;
  onGuestChange: (value: GuestDetails) => void;
  disclosure: PublicQuoteGuestDisclosure | null;
  rulesFailed: boolean;
  onRetryRules: () => void;
  termsText: string | null;
  locked: boolean;
  /** The last guest rules known, so the form stays steady while a new price's rules load. */
  rules: PublicQuoteGuestDisclosure["choices"] | null;
}) {
  if (!quote)
    return (
      <div className="space-y-6">
        <GuestDetailsForm value={guest} onChange={onGuestChange} rules={rules} locked={locked} />
        {termsText && <BookingPageTerms text={termsText} />}
      </div>
    );
  const money = (minor: string) => formatMoney(minor, quote.currency);
  const lineTotal = (selectionId: string) =>
    String(
      quote.lines
        .filter((l) => l.selectionId === selectionId && (l.kind === "room" || l.kind === "meal"))
        .reduce((total, l) => total + BigInt(l.amountMinor), BigInt(0)),
    );
  const extras = quote.lines.filter((l) => l.kind === "addon");
  return (
    <div className="space-y-6">
      <section aria-label="Booking summary" className={card}>
        <h2 className="text-lg font-bold text-gray-900 mb-5">Booking Summary</h2>
        {rooms.map((room) => (
          <div
            key={room.selectionId}
            className="flex items-start gap-4 pb-5 mb-5 border-b border-gray-100 last:mb-0"
          >
            <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
              {room.image && (
                <Image src={room.image} alt="" fill className="object-cover" sizes="64px" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900">{room.name}</p>
              <p className="text-sm text-gray-700">{room.choice}</p>
              <p className="text-sm text-gray-500">{stayLine}</p>
            </div>
            <p className="text-sm font-bold text-gray-900">{money(lineTotal(room.selectionId))}</p>
          </div>
        ))}
        {extras.length > 0 && (
          <div className="flex items-center justify-between pb-5 border-b border-gray-100">
            <p className="text-sm text-gray-700">Extras</p>
            <p className="text-sm font-semibold text-gray-900">
              {money(String(extras.reduce((t, l) => t + BigInt(l.amountMinor), BigInt(0))))}
            </p>
          </div>
        )}
        <div className="flex items-center justify-between pt-4">
          <p className="text-base font-bold text-gray-900">Total</p>
          <div className="text-right">
            <p className="text-xl font-bold text-gray-900">{money(quote.totalMinor)}</p>
            <p className="text-xs text-gray-500">Includes taxes &amp; fees</p>
          </div>
        </div>
      </section>

      <GuestDetailsForm value={guest} onChange={onGuestChange} rules={rules} locked={locked} />

      <section aria-label="Guest rules" className={card}>
        <h2 className="text-lg font-bold text-gray-900 mb-4">Our guest rules</h2>
        {rulesFailed ? (
          <div
            role="alert"
            className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"
          >
            <p className="font-semibold">We couldn’t check our guest rules for this price.</p>
            <p className="mt-1">
              You can keep filling in your details. You can continue once we have checked them.
            </p>
            <button
              type="button"
              className="mt-3 rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white"
              onClick={onRetryRules}
            >
              Try again
            </button>
          </div>
        ) : !disclosure ? (
          <p role="status" className="text-sm text-gray-500">
            Loading our guest rules…
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            <p className="pb-2.5 text-xs text-gray-500">
              Times are in {disclosure.propertyTimeZone}.
            </p>
            {ruleLines(disclosure).map(([title, text]) => (
              <div key={title} className="flex justify-between gap-6 py-2.5 text-sm">
                <span className="text-gray-500">{title}</span>
                <span className="text-gray-900 text-right">{text}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Room and rate terms" className={card}>
        <h2 className="text-lg font-bold text-gray-900 mb-4">Your room and rate terms</h2>
        <div className="space-y-4">
          {quote.rooms.map((room, index) => {
            const named = rooms.find((r) => r.selectionId === room.selectionId);
            return (
              <div key={room.selectionId} className="space-y-1 text-sm">
                <p className="font-semibold text-gray-900">
                  {named ? `${named.name} · ${named.choice}` : `Room ${index + 1}`}
                </p>
                {rateTerms(room).map((line) => (
                  <p key={line} className="text-gray-700 whitespace-pre-wrap break-words">
                    {line}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      {termsText && <BookingPageTerms text={termsText} />}
    </div>
  );
}
