"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

/**
 * The amber line for page views that aren't being counted (VAY-2594): guests finished at least
 * two bookings on the booking page this week, yet no page view arrived. Bookings are still
 * recorded; visitors and the conversion rate fall short. No link: no hotel setting turns page
 * views on (decision 113).
 */
export function TrackingBanner({ t }: { t: (key: string) => string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[10px] border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[#93370D]"
    >
      <ExclamationTriangleIcon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
      <p className="min-w-0 flex-1 text-sm">
        <strong>{t("dashboard.tracking.title")}</strong> {t("dashboard.tracking.detail")}
      </p>
    </div>
  );
}
