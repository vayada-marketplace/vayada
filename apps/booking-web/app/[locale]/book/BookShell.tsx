"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import StepIndicator from "@/components/booking/StepIndicator";
import BookingFooter from "@/components/layout/BookingFooter";
import CheckoutFooter from "@/components/layout/CheckoutFooter";
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
 * Your details" with a thin progress bar takes the place of the title and the step indicator.
 * Timo's boards: the bar stays at the top while the page scrolls, the name in the hotel's colour and
 * font on one line, the progress in one segment per step; "Your details" sits on white and ends in
 * a slim footer. */
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
  const done = Math.max(1, number);
  const details = current === "details";
  return (
    // The step's "Your stay" bar is fixed to the bottom of a phone's screen: the footer clears it.
    <div
      className={`min-h-screen bg-gray-50 pb-[var(--fixed-bottom-bar,0px)]${details ? " max-lg:bg-white" : ""}`}
    >
      <div className="max-lg:hidden">
        <BookingNavigation solid />
      </div>
      {/* Stays at the top; globals.css keeps a focused field clear of it. */}
      <header
        data-checkout-header
        className="sticky top-0 z-10 border-b border-gray-200 bg-white lg:hidden"
      >
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
          {/* Centred on the screen, clear of the arrow, as the hotel's bar shows it; a long name
              ends in "…". */}
          <p className="pointer-events-none absolute inset-x-14 truncate text-center font-heading text-xl font-semibold text-primary-700">
            {name}
          </p>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-baseline gap-1 text-[13px] leading-5 text-gray-600">
            <span className="shrink-0">
              {t("progress", { current: done, total: steps.length })} ·
            </span>
            <h1 className="min-w-0 truncate font-semibold text-gray-900">{title}</h1>
          </div>
          {/* One segment per step, the steps so far in the brand colour. */}
          <div
            data-testid="checkout-progress"
            className="mt-1.5 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
            aria-hidden="true"
          >
            {steps.map((step, index) => (
              <span
                key={step}
                className={`h-1 rounded-full ${index < done ? "bg-primary-600" : "bg-gray-200"}`}
              />
            ))}
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
      {details ? (
        <>
          <div className="max-lg:hidden">
            <BookingFooter />
          </div>
          <CheckoutFooter />
        </>
      ) : (
        <BookingFooter />
      )}
    </div>
  );
}
