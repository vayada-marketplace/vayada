"use client";

import type { ComponentProps, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import DatePickerCalendar from "@/components/booking/DatePickerCalendar";
import GuestSelector from "@/components/booking/GuestSelector";
import { formatDate, formatDateShort } from "@/lib/utils";

/** The search card's open panel; one at a time. */
export type SearchPanel = "calendar" | "guests" | "promo" | null;

/**
 * The search card under a booking page's hero (`#stay-search`, sticky on scroll): the stay's
 * dates, its guests, an optional promo field (`promo`, see PromoField) and Check Availability.
 * Which panel is open is the page's (`panel`), so it can open one from elsewhere. Shared by a
 * hotel's page and an agency's (VAY-2459).
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
  guests,
  promo,
  onCheck,
}: {
  panel: SearchPanel;
  onPanel: (panel: SearchPanel) => void;
  checkIn: string;
  checkOut: string;
  nights: number;
  onDates: (checkIn: string, checkOut: string) => void;
  adults: number;
  childCount: number;
  /** The guests' third line, under the count. */
  guestsNote: string;
  guests: Omit<ComponentProps<typeof GuestSelector>, "open" | "onClose" | "adults" | "childCount">;
  promo?: ReactNode;
  /** After every panel closed. */
  onCheck: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  return (
    <div id="stay-search" className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-row flex-wrap items-center gap-4 md:gap-6">
        {/* Dates — clickable to open calendar */}
        <div className="relative flex-1 min-w-[120px]">
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
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t("yourStay")}
              </p>
              <p className="text-base font-semibold text-gray-900">
                {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)}
              </p>
              <p className="text-sm text-gray-500">{tc("nights", { count: nights })}</p>
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

        {/* Divider */}
        <div className="w-px h-12 bg-gray-200" />

        {/* Guests — clickable to open selector */}
        <div className="relative w-auto min-w-[100px]">
          <button
            onClick={() => onPanel(panel === "guests" ? null : "guests")}
            className="flex items-center gap-3 w-full hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
          >
            <div className="hidden md:flex w-10 h-10 rounded-full bg-primary-50 items-center justify-center flex-shrink-0">
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
            <div className="text-left">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {tc("guests")}
              </p>
              <p className="text-base font-semibold text-gray-900 whitespace-nowrap">
                {tc("adults", { count: adults })}
                {childCount > 0 && `, ${tc("children", { count: childCount })}`}
              </p>
              <p className="text-sm text-gray-500">{guestsNote}</p>
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
