"use client";

import type { ComponentProps, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import DatePickerCalendar from "@/components/booking/DatePickerCalendar";
import GuestSelector from "@/components/booking/GuestSelector";
import { formatDate, formatDateShort, resolveLocale } from "@/lib/utils";

/** The search card's open panel; one at a time. */
export type SearchPanel = "calendar" | "guests" | "promo" | null;

/** A phone's stay date (VAY-2494): "Fri 13 Nov", with the year only when it isn't this year. The
 * hotel's calendar day, in any time zone. */
export function phoneStayDate(date: string, locale: string, thisYear = new Date().getFullYear()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(Number(date.slice(0, 4)) !== thisYear && { year: "numeric" }),
    timeZone: "UTC",
  });
}

/**
 * The search card under a booking page's hero (`#stay-search`, sticky on scroll from tablets up):
 * the stay's dates, its guests, an optional promo field (`promo`, see PromoField) and Check
 * Availability. Which panel is open is the page's (`panel`), so it can open one from elsewhere.
 * Shared by a hotel's page and an agency's (VAY-2459). An agency's pages keep it in place below
 * `lg`, and its stay page has no hero on phones (VAY-2463).
 *
 * On phones (VAY-2494) it never sticks: it overlaps the hero by 64px, the dates and the guests are
 * two full-width rows, Check Availability spans the card and the promo is a small link under it.
 * The hotel page shows a compact bar instead once the card is out of view (StickySearchBar).
 */
export default function StaySearchCard({
  panel,
  onPanel,
  checkIn,
  checkOut,
  nights,
  onDates,
  adults,
  childCount,
  guestsNote,
  guestsAside,
  guests,
  promo,
  onCheck,
  stickyOnTablets = true,
  heroOnPhones = true,
}: {
  panel: SearchPanel;
  onPanel: (panel: SearchPanel) => void;
  checkIn: string;
  checkOut: string;
  nights: number;
  onDates: (checkIn: string, checkOut: string) => void;
  adults: number;
  childCount: number;
  /** The guests' third line, under the count (tablets and up). */
  guestsNote: string;
  /** Phones: said right of the guests, such as "2 rooms". */
  guestsAside?: string;
  guests: Omit<ComponentProps<typeof GuestSelector>, "open" | "onClose" | "adults" | "childCount">;
  promo?: ReactNode;
  /** After every panel closed. */
  onCheck: () => void;
  /** False: sticky from `lg` up only; true: from `md` (phones never, VAY-2494). */
  stickyOnTablets?: boolean;
  /** False: below `lg` the card starts under the page's bar instead of over a hero. */
  heroOnPhones?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const tp = useTranslations("home.phoneSearch");
  return (
    <div
      id="stay-search"
      className={`${stickyOnTablets ? "relative md:sticky md:top-4" : "relative lg:sticky lg:top-4"} z-30 max-w-5xl mx-auto px-4 ${heroOnPhones ? "-mt-16 md:-mt-10" : "mt-4 lg:-mt-10"}`}
    >
      {/* Phones: one column. From `md` up these resolve to the row it has always been. */}
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-col md:flex-row md:flex-wrap md:items-center gap-3 md:gap-6">
        {/* Dates — clickable to open calendar */}
        <div className="relative md:flex-1 md:min-w-[120px]">
          <button
            onClick={() => onPanel(panel === "calendar" ? null : "calendar")}
            className="flex items-center gap-3 w-full text-left hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-5 h-5 text-primary-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div className="hidden md:block">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t("yourStay")}
              </p>
              <p className="text-base font-semibold text-gray-900">
                {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)}
              </p>
              <p className="text-sm text-gray-500">{tc("nights", { count: nights })}</p>
            </div>
            {/* Phones: "Fri 13 Nov → Sat 14 Nov" on one line, the nights on the right. */}
            <div className="flex min-w-0 flex-1 items-center gap-2 md:hidden">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-500">{tp("dates")}</p>
                <p
                  data-testid="phone-stay-dates"
                  className="text-[15px] font-semibold text-gray-900"
                >
                  <span className="inline-block">{phoneStayDate(checkIn, locale)} →</span>{" "}
                  <span className="inline-block">{phoneStayDate(checkOut, locale)}</span>
                </p>
              </div>
              <span className="shrink-0 text-sm text-gray-500">
                {tc("nights", { count: nights })}
              </span>
            </div>
          </button>
          <DatePickerCalendar
            open={panel === "calendar"}
            onClose={() => onPanel(null)}
            checkIn={checkIn}
            checkOut={checkOut}
            onSelect={onDates}
          />
        </div>

        {/* Divider: a line between the rows on phones */}
        <div className="h-px w-full bg-gray-200 md:w-px md:h-12" />

        {/* Guests — clickable to open selector */}
        <div className="relative w-auto min-w-[100px]">
          <button
            onClick={() => onPanel(panel === "guests" ? null : "guests")}
            className="flex items-center gap-3 w-full hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
          >
            <div className="flex w-10 h-10 rounded-full bg-primary-50 items-center justify-center flex-shrink-0">
              <svg
                className="w-5 h-5 text-primary-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </div>
            <div className="hidden md:block text-left">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {tc("guests")}
              </p>
              <p className="text-base font-semibold text-gray-900 whitespace-nowrap">
                {tc("adults", { count: adults })}
                {childCount > 0 && `, ${tc("children", { count: childCount })}`}
              </p>
              <p className="text-sm text-gray-500">{guestsNote}</p>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-left md:hidden">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-500">{tc("guests")}</p>
                <p className="text-[15px] font-semibold text-gray-900">
                  {t("roomsProgress.guests", { adults, children: childCount })}
                </p>
              </div>
              {guestsAside && <span className="shrink-0 text-sm text-gray-500">{guestsAside}</span>}
            </div>
          </button>
          <GuestSelector
            {...guests}
            open={panel === "guests"}
            onClose={() => onPanel(null)}
            adults={adults}
            childCount={childCount}
          />
        </div>

        {promo && (
          <>
            {/* Divider */}
            <div className="hidden md:block w-px h-12 bg-gray-200" />
            {promo}
          </>
        )}

        {/* Check Availability Button */}
        <button
          onClick={() => {
            onPanel(null);
            onCheck();
          }}
          className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap flex items-center justify-center gap-2"
        >
          {tc("checkAvailability")}
        </button>
      </div>
    </div>
  );
}
