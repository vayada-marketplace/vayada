"use client";

import { useLocale, useTranslations } from "next-intl";
import { resolveLocale } from "@/lib/utils";

/** "Mon, 26 Oct" and "2026" for a stay date (YYYY-MM-DD), read as the hotel's calendar day: the site's
 * full stay date (formatStayDate) with its year taken out, so each language keeps its punctuation. */
function dayParts(date: string, locale: string) {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return { day: "—", year: "" };
  const parts = new Intl.DateTimeFormat(resolveLocale(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(value);
  const at = parts.findIndex((part) => part.type === "year");
  const day = parts
    .filter(
      (part, index) =>
        index !== at && !(part.type === "literal" && (index === at - 1 || index === at + 1)),
    )
    .map((part) => part.value)
    .join("")
    .trim();
  return { day, year: parts[at]?.value ?? "" };
}

/** VAY-2360: check-in and check-out in one block of two equal columns built the same way (label, short date,
 * year and time), so the two dates always line up; the night count sits top right. */
export default function StayDates({
  checkIn,
  checkOut,
  checkInTime,
  checkOutTime,
  nights,
  ended,
  labelClass,
}: {
  checkIn: string;
  checkOut: string;
  /** "from 15:00", "15:00–22:00" or nothing. */
  checkInTime?: string;
  checkOutTime?: string;
  nights: number | null;
  /** A cancelled, declined or expired stay: the dates are struck through. */
  ended: boolean;
  labelClass: string;
}) {
  const t = useTranslations("confirmation");
  const tc = useTranslations("common");
  const locale = useLocale();
  const column = (label: string, date: string, time: string | undefined) => {
    const { day, year } = dayParts(date, locale);
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center">
          <span className={`${labelClass} whitespace-nowrap`}>{label}</span>
        </div>
        <span
          data-testid="stay-day"
          className={`whitespace-nowrap font-heading text-[22px] leading-7 lining-nums sm:text-[30px] sm:leading-9 ${ended ? "text-gray-500 line-through" : "text-gray-900"}`}
        >
          {day}
        </span>
        <span className="text-[13px] text-gray-600 sm:text-sm">
          {[year, time].filter(Boolean).join(" · ")}
        </span>
      </div>
    );
  };
  return (
    <div className="relative flex items-stretch gap-4 px-[18px] py-[18px] sm:gap-7 sm:px-7 sm:py-[22px]">
      {column(t("checkIn"), checkIn, checkInTime)}
      <span aria-hidden="true" className="w-px shrink-0 bg-gray-200" />
      {column(t("checkOut"), checkOut, checkOutTime)}
      {/* In the block's corner, so it never squeezes a column's label. */}
      {nights && (
        <span className="absolute right-[18px] top-[18px] whitespace-nowrap rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700 sm:right-7 sm:top-[22px]">
          {tc("nights", { count: nights })}
        </span>
      )}
    </div>
  );
}
