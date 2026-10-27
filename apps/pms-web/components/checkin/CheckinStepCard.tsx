"use client";

import type { ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";

export const checkinPrimaryButton =
  "flex h-11 items-center justify-center rounded-xl bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2";
export const checkinSecondaryButton =
  "flex h-11 items-center justify-center rounded-xl border border-gray-200 bg-white px-5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary-500";

/** One step of the check-in: "Step 2 of 4", its title, the body and Back / Continue (VAY-2373). */
export function CheckinStepCard({
  step,
  total,
  title,
  subtitle,
  children,
  onBack,
  hint,
  primary,
}: {
  step: number;
  total: number;
  title: string;
  subtitle: string;
  children: ReactNode;
  onBack?: () => void;
  hint?: ReactNode;
  primary: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="checkin-step-title"
      className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white"
    >
      <header className="border-b border-gray-200 px-4 py-5 md:px-8 md:py-7">
        <p className="text-sm text-gray-600">{t("checkIn.flow.stepOf", { step, total })}</p>
        <h2 id="checkin-step-title" className="mt-1 text-2xl font-extrabold text-gray-900">
          {title}
        </h2>
        <p className="mt-1 text-[15px] text-gray-600">{subtitle}</p>
      </header>
      <div className="px-4 py-5 md:px-8 md:py-7">{children}</div>
      <footer className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50 px-4 py-4 md:flex-row md:items-center md:px-8 md:py-5">
        {hint && (
          <p className="text-center text-sm text-gray-600 md:order-2 md:ml-auto md:text-right">
            {hint}
          </p>
        )}
        <div
          className={`grid gap-3 md:order-3 md:flex ${onBack ? "grid-cols-2" : "grid-cols-1"} ${
            hint ? "" : "md:ml-auto"
          }`}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className={`${checkinSecondaryButton} md:hidden`}
            >
              {t("checkIn.flow.back")}
            </button>
          )}
          {primary}
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className={`${checkinSecondaryButton} hidden md:order-1 md:flex`}
          >
            {t("checkIn.flow.back")}
          </button>
        )}
      </footer>
    </section>
  );
}
