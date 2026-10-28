"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  isManualPricingPaymentMethod,
  type PricingPaymentMethod,
  type PublicBookingQuote,
  type PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { serverNow } from "@/lib/serverClock";
import { resolveLocale } from "@/lib/utils";

/** One booked room as the guest knows it: its name, plain choice name, photo and guests. */
export type SummaryRoom = {
  selectionId: string;
  name: string;
  choice: string;
  image?: string;
  guests?: string;
};

function Row({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-[15px]">
      <span className="text-gray-600">
        {label}
        {sub && <span className="block text-sm text-gray-500">{sub}</span>}
      </span>
      <span className="font-semibold text-gray-900 text-right">{value}</span>
    </div>
  );
}

const sum = (lines: PublicBookingQuote["lines"]) =>
  lines.reduce((total, line) => total + BigInt(line.amountMinor), BigInt(0));
const icon = (d: string, className: string) => (
  <svg
    className={`h-4 w-4 shrink-0 ${className}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={d} />
  </svg>
);

/** "14:52" left on the price, on the server's clock; null once it ran out. */
function useTimeLeft(expiresAt: string): string | null {
  const left = () => Math.max(0, Date.parse(expiresAt) - serverNow());
  const [ms, setMs] = useState(left);
  useEffect(() => {
    setMs(left());
    const timer = setInterval(() => setMs(left()), 1000);
    return () => clearInterval(timer);
    // `left` reads only expiresAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  if (ms <= 0) return null;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "Your stay" (VAY-2347), the one summary on steps 2 and 3: the rooms, the dates with the hotel's
 * times, what the price charges and its total, then how the guest can pay (step 2) or the chosen
 * way's payment lines (step 3), and how long the price is held. */
export default function StaySummary({
  quote,
  rooms,
  guests,
  rules,
  formatMoney,
  methods,
  box,
  expired = false,
}: {
  quote: PublicBookingQuote;
  rooms: SummaryRoom[];
  guests: string;
  rules: PublicQuoteGuestDisclosure["choices"] | null;
  formatMoney: (minor: string, currency: string) => string;
  /** Step 2: the ways the hotel offers for these rooms, as one line. */
  methods?: readonly PricingPaymentMethod[];
  /** Step 3: the chosen way's lines ("Pay now", "At the hotel"). */
  box?: readonly { label: string; value: string }[];
  expired?: boolean;
}) {
  const t = useTranslations("reviewPay");
  const locale = useLocale();
  const timeLeft = useTimeLeft(quote.expiresAt);
  const money = (minor: bigint | string) => formatMoney(String(minor), quote.currency);
  const day = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const nights = Math.round((Date.parse(quote.checkOut) - Date.parse(quote.checkIn)) / 86_400_000);
  const extras = quote.lines.filter((line) => line.kind === "addon");
  const charges = quote.lines.filter((line) => line.kind === "charge");
  // Every quote has a promo-code discount line, "0" without a code: show only a real discount
  // (VAY-2388).
  const discount = sum(quote.lines.filter((line) => line.kind === "discount"));
  const single = rooms.length === 1 ? rooms[0] : undefined;
  const ranOut = expired || !timeLeft;
  // Bank transfer and PayPal confirm once the money arrives, so "instant" holds only without them.
  const instant =
    quote.acceptanceMode === "instant" &&
    !isManualPricingPaymentMethod(quote.paymentMethod) &&
    !methods?.some(isManualPricingPaymentMethod);
  const ways = methods?.length
    ? t("stay.methods", {
        methods: new Intl.ListFormat(resolveLocale(locale), { type: "disjunction" }).format(
          methods.map((method) => t(`method.${method}.phrase`)),
        ),
      })
    : null;
  return (
    <aside
      aria-label={t("stay.title")}
      className="bg-white rounded-2xl border border-gray-200 p-5 md:p-7 lg:sticky lg:top-8 space-y-[18px]"
    >
      <div>
        <h2 className="text-xl font-bold text-gray-900">{t("stay.title")}</h2>
        {single && (
          <>
            <p className="mt-1 text-base font-semibold text-gray-900">{single.name}</p>
            <p className="text-sm text-gray-600">
              {[single.choice, guests].filter(Boolean).join(" · ")}
            </p>
          </>
        )}
        {!single && <p className="mt-1 text-sm text-gray-600">{guests}</p>}
      </div>
      <div className="flex gap-4 border-y border-gray-200 py-[18px]">
        {[
          [t("stay.checkIn"), quote.checkIn, rules && t("stay.from", { time: rules.checkInTime })],
          [t("stay.checkOut"), quote.checkOut, rules && t("stay.by", { time: rules.checkOutTime })],
        ].map(([label, date, time]) => (
          <div key={label as string} className="flex-1">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-500">{label}</p>
            <p className="text-base font-bold text-gray-900">{day(date as string)}</p>
            {time && <p className="text-sm text-gray-600">{time}</p>}
          </div>
        ))}
      </div>
      <div className="space-y-3">
        {rooms.map((room, index) => (
          <Row
            key={room.selectionId}
            label={
              single
                ? t("stay.nights", { count: nights })
                : `${t("stay.room", { number: String(index + 1) })} · ${room.name}`
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
            sub={single ? undefined : [room.choice, room.guests].filter(Boolean).join(" · ")}
          />
        ))}
        {extras.length > 0 && <Row label={t("stay.extras")} value={money(sum(extras))} />}
        {charges.length > 0 && <Row label={t("stay.fees")} value={money(sum(charges))} />}
        {discount > BigInt(0) && <Row label={t("stay.discount")} value={`−${money(discount)}`} />}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[17px] font-bold text-gray-900">{t("stay.total")}</span>
          <span
            data-testid="stay-total"
            className={`text-[26px] font-bold ${ranOut ? "text-gray-400 line-through" : "text-gray-900"}`}
          >
            {money(quote.totalMinor)}
          </span>
        </div>
        <p className="text-right text-[13px] text-gray-500">{t("stay.includes")}</p>
      </div>
      {((!!box?.length && !ranOut) || ways) && (
        <div className="space-y-2.5 rounded-xl bg-gray-50 px-4 py-3.5 text-sm">
          {box?.length && !ranOut
            ? box.map((line) => (
                <div key={line.label} className="flex justify-between gap-4">
                  <span className="text-gray-600">{line.label}</span>
                  <span className="font-bold text-gray-900 text-right">{line.value}</span>
                </div>
              ))
            : [ways, instant && t("stay.instant")].filter(Boolean).map((line) => (
                <p key={line as string} className="flex items-center gap-2 text-gray-700">
                  {icon("M5 13l4 4L19 7", "text-green-700")}
                  {line}
                </p>
              ))}
        </div>
      )}
      <p
        className={`flex items-center gap-2 text-sm ${ranOut ? "font-medium text-amber-700" : "text-gray-600"}`}
      >
        {icon("M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z", "")}
        {ranOut ? t("stay.expired") : t("stay.hold", { time: timeLeft! })}
      </p>
    </aside>
  );
}
