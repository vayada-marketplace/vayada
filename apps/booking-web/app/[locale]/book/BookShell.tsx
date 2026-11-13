"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import StepIndicator from "@/components/booking/StepIndicator";
import BookingFooter from "@/components/layout/BookingFooter";
import BookingNavigation from "@/components/layout/BookingNavigation";
import { useAgencyPage, useHotel } from "@/contexts/HotelContext";
import type { BookStep } from "@/lib/bookFlow";

const backIcon = (className: string) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);

/** The frame around each /book step (VAY-2195): a slim bar with the hotel's name, Contact and
 * language instead of the hero (VAY-2448), the step's title with the step indicator, and the
 * footer. VAY-2416: "Back to …" sits above the title. VAY-2448: once the rooms are chosen, the
 * indicator's Rooms goes back to them.
 *
 * VAY-2495: below lg (where "Your stay" is a bar at the bottom) the checkout has its own 56px bar:
 * a back arrow and the property's name, no Contact, language or currency. Under it, "Step 2 of 3 ·
 * Your details" with a thin progress bar takes the place of the title and the step indicator. */
export default function BookShell({
  steps,
  current,
  title,
  subtitle,
  children,
  back,
  exit,
  rooms,
}: {
  steps: readonly BookStep[];
  current: BookStep;
  title: string;
  subtitle?: string;
  children: ReactNode;
  back?: { label: string; onClick: () => void; disabled?: boolean };
  /** The phone bar's arrow where a step has no Back (the rooms step, a step still loading). */
  exit?: { label: string; onClick: () => void };
  /** Back to the rooms from the indicator's Rooms, after the rooms step. */
  rooms?: { onClick: () => void; disabled?: boolean };
}) {
  const t = useTranslations("steps");
  const { hotel } = useHotel();
  // VAY-2462: on an agency's address the name is the agency page's, as in its bar.
  const { agency } = useAgencyPage();
  const name = agency ? agency.page.title : hotel.name;
  const labels: Record<BookStep, string> = {
    rooms: t("rooms"),
    extras: t("addons"),
    details: t("details"),
    payment: t("payment"),
  };
  const number = steps.indexOf(current) + 1;
  const arrow = back ?? exit;
  return (
    // The step's "Your stay" bar is fixed to the bottom of a phone's screen: the footer clears it.
    <div className="min-h-screen bg-gray-50 pb-[var(--fixed-bottom-bar,0px)]">
      <div className="max-lg:hidden">
        <BookingNavigation solid />
      </div>
      <header className="border-b border-gray-200 bg-white lg:hidden">
        <div className="relative flex h-14 items-center px-2">
          {arrow && (
            <button
              type="button"
              onClick={arrow.onClick}
              disabled={back?.disabled}
              aria-label={arrow.label}
              className="relative z-10 flex h-11 w-11 items-center justify-center rounded-full text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-40"
            >
              {backIcon("h-6 w-6")}
            </button>
          )}
          {/* Centred on the screen, clear of the arrow; a very long name takes two lines. */}
          <p className="pointer-events-none absolute inset-x-14 line-clamp-2 text-center font-heading text-lg font-semibold leading-tight text-gray-900">
            {name}
          </p>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-baseline gap-1 text-[13px] leading-5 text-gray-600">
            <span className="shrink-0">
              {t("progress", { current: Math.max(1, number), total: steps.length })} ·
            </span>
            <h1 className="min-w-0 truncate font-semibold text-gray-900">{title}</h1>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary-600"
              style={{ width: `${(Math.max(1, number) / steps.length) * 100}%` }}
            />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-5 pb-10 lg:py-10">
        <div className="max-lg:hidden flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <div>
            {back && (
              <button
                type="button"
                onClick={back.onClick}
                disabled={back.disabled}
                className="mb-2 flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-40"
              >
                {backIcon("h-4 w-4")}
                {back.label}
              </button>
            )}
            <h1 className="text-[22px] leading-[30px] font-heading text-gray-900">{title}</h1>
            {subtitle && <p className="text-gray-500 mt-1">{subtitle}</p>}
          </div>
          <StepIndicator
            steps={steps.map((step, index) => ({ number: index + 1, label: labels[step] }))}
            currentStep={number}
            back={rooms && current !== "rooms" ? { step: 1, ...rooms } : undefined}
          />
        </div>
        {subtitle && <p className="mb-5 text-[15px] text-gray-600 lg:hidden">{subtitle}</p>}
        {children}
      </main>
      <BookingFooter />
    </div>
  );
}
