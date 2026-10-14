"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { deviceTimeOf } from "@/lib/serverClock";

/** One booked room as the guest knows it: its name, plain choice name and photo. */
export type SummaryRoom = { selectionId: string; name: string; choice: string; image?: string };

function Row({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-gray-900 text-right">
        {value}
        {sub && <span className="block text-xs font-normal text-gray-500">{sub}</span>}
      </span>
    </div>
  );
}

const sum = (lines: PublicBookingQuote["lines"]) =>
  lines.reduce((total, line) => total + BigInt(line.amountMinor), BigInt(0));

/** The old "Your Stay" sidebar on pricing v2 (VAY-2195): the stay, then what the quote charges
 * for each room, the extras, any discount and fees, and the total. */
export default function StaySummary({
  title,
  quote,
  rooms,
  guests,
  rules,
  formatMoney,
  formatDate,
  payment,
  expired = false,
}: {
  title: string;
  quote: PublicBookingQuote;
  rooms: SummaryRoom[];
  guests: string;
  rules: PublicQuoteGuestDisclosure["choices"] | null;
  formatMoney: (minor: string, currency: string) => string;
  formatDate: (date: string) => string;
  /** Pay now and pay at the hotel, once the guest chose how to pay. */
  payment?: boolean;
  expired?: boolean;
}) {
  const money = (minor: bigint | string) => formatMoney(String(minor), quote.currency);
  const nights = Math.round((Date.parse(quote.checkOut) - Date.parse(quote.checkIn)) / 86_400_000);
  const extras = quote.lines.filter((line) => line.kind === "addon");
  const charges = quote.lines.filter((line) => line.kind === "charge");
  const discounts = quote.lines.filter((line) => line.kind === "discount");
  const single = rooms.length === 1 ? rooms[0] : undefined;
  const holdUntil = new Date(deviceTimeOf(quote.expiresAt)).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <aside
      aria-label={title}
      className="bg-white rounded-2xl border border-gray-200 p-6 lg:sticky lg:top-8"
    >
      <h2 className="text-lg font-bold text-gray-900 mb-5">{title}</h2>
      {single && (
        <div className="flex items-center gap-3 pb-5 mb-5 border-b border-gray-100">
          <div className="relative w-14 h-14 rounded-xl overflow-hidden flex-shrink-0 bg-gray-100">
            {single.image && (
              <Image src={single.image} alt="" fill className="object-cover" sizes="56px" />
            )}
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">{single.name}</p>
            <p className="text-xs text-gray-500">{single.choice}</p>
          </div>
        </div>
      )}
      <div className="space-y-3 pb-5 border-b border-gray-100">
        <Row
          label="Check-in"
          value={formatDate(quote.checkIn)}
          sub={rules ? `Check-in from ${rules.checkInTime}` : undefined}
        />
        <Row
          label="Check-out"
          value={formatDate(quote.checkOut)}
          sub={rules ? `Check-out by ${rules.checkOutTime}` : undefined}
        />
        <Row label="Duration" value={`${nights} ${nights === 1 ? "night" : "nights"}`} />
        <Row label="Guests" value={guests} />
      </div>
      <div className="space-y-3 py-5 border-b border-gray-100">
        {rooms.map((room, index) => (
          <Row
            key={room.selectionId}
            label={
              single
                ? `Room (${nights} ${nights === 1 ? "night" : "nights"})`
                : `Room ${index + 1} · ${room.name}`
            }
            value={money(
              sum(
                quote.lines.filter(
                  (line) =>
                    line.selectionId === room.selectionId &&
                    (line.kind === "room" || line.kind === "meal"),
                ),
              ),
            )}
            sub={single ? undefined : room.choice}
          />
        ))}
        {extras.length > 0 && <Row label="Extras" value={money(sum(extras))} />}
        {charges.length > 0 && <Row label="Fees" value={money(sum(charges))} />}
        {discounts.length > 0 && <Row label="Discount" value={`−${money(sum(discounts))}`} />}
      </div>
      <div className="pt-5">
        <div className="flex justify-between items-start">
          <span className="text-base font-bold text-gray-900">Total</span>
          <div className="text-right">
            <p
              className={`text-xl font-bold ${expired ? "text-gray-400 line-through" : "text-gray-900"}`}
            >
              {money(quote.totalMinor)}
            </p>
            <p className="text-xs text-gray-500">Includes taxes &amp; fees</p>
          </div>
        </div>
        {payment && (
          <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
            <Row label="Pay now" value={money(quote.dueNowMinor)} />
            <Row label="At the hotel" value={money(quote.dueLaterMinor)} />
          </div>
        )}
        <p className={`mt-4 text-xs ${expired ? "text-amber-700 font-medium" : "text-gray-500"}`}>
          {expired
            ? `This price expired at ${holdUntil}.`
            : `We hold this price for you until ${holdUntil}.`}
        </p>
      </div>
    </aside>
  );
}
