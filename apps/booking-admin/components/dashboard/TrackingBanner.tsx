"use client";

import Link from "next/link";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

/**
 * The amber line for page views that aren't being counted (VAY-2594): guests finished at least
 * two bookings on the booking page this week, yet no page view arrived. Bookings are still
 * recorded; visitors and the conversion rate fall short. Check setup leads to the page's
 * address, where a hotel can see the link its website should use.
 */
export function TrackingBanner({ t }: { t: (key: string) => string }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-[#FEDF89] bg-[#FFFAEB] px-4 py-3 text-[#93370D]"
    >
      <ExclamationTriangleIcon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
      <p className="min-w-[12rem] flex-1 text-sm">
        <strong>{t("dashboard.tracking.title")}</strong> {t("dashboard.tracking.detail")}
      </p>
      <Link
        href="/design-studio?tab=domain"
        className="text-[13px] font-semibold text-inherit hover:underline"
      >
        {t("dashboard.tracking.checkSetup")} →
      </Link>
    </div>
  );
}
