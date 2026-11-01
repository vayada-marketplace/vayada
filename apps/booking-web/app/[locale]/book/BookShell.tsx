"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import StepIndicator from "@/components/booking/StepIndicator";
import BookingFooter from "@/components/layout/BookingFooter";
import BookingNavigation from "@/components/layout/BookingNavigation";
import type { BookStep } from "@/lib/bookFlow";

/** The frame around each /book step (VAY-2195): a slim bar with the hotel's name, Contact and
 * language instead of the hero (VAY-2448), the step's title with the step indicator, and the
 * footer. VAY-2416: "Back to …" sits above the title. VAY-2448: once the rooms are chosen, the
 * indicator's Rooms goes back to them. */
export default function BookShell({
  steps,
  current,
  title,
  subtitle,
  children,
  back,
  rooms,
}: {
  steps: readonly BookStep[];
  current: BookStep;
  title: string;
  subtitle?: string;
  children: ReactNode;
  back?: { label: string; onClick: () => void; disabled?: boolean };
  /** Back to the rooms from the indicator's Rooms, after the rooms step. */
  rooms?: { onClick: () => void; disabled?: boolean };
}) {
  const t = useTranslations("steps");
  const labels: Record<BookStep, string> = {
    rooms: t("rooms"),
    extras: t("addons"),
    details: t("details"),
    payment: t("payment"),
  };
  return (
    // The step's "Your stay" bar is fixed to the bottom of a phone's screen: the footer clears it.
    <div className="min-h-screen bg-gray-50 pb-[var(--fixed-bottom-bar,0px)]">
      <BookingNavigation solid />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <div>
            {back && (
              <button
                type="button"
                onClick={back.onClick}
                disabled={back.disabled}
                className="mb-2 flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-40"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                {back.label}
              </button>
            )}
            <h1 className="text-[22px] leading-[30px] font-heading text-gray-900">{title}</h1>
            {subtitle && <p className="text-gray-500 mt-1">{subtitle}</p>}
          </div>
          <StepIndicator
            steps={steps.map((step, index) => ({ number: index + 1, label: labels[step] }))}
            currentStep={steps.indexOf(current) + 1}
            back={rooms && current !== "rooms" ? { step: 1, ...rooms } : undefined}
          />
        </div>
        {children}
      </main>
      <BookingFooter />
    </div>
  );
}
