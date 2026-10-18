"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pmsSetupExitPropertyId } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";

/** Shown after "Exit setup" brings a hotel back here with unfinished setup (VAY-2249). */
export function ResumeSetupBanner() {
  const { t } = useTranslation();
  const [propertyId, setPropertyId] = useState<string | null>(null);

  useEffect(() => {
    setPropertyId(pmsSetupExitPropertyId(`${window.location.pathname}${window.location.search}`));
  }, []);

  if (!propertyId) return null;
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p>{t("dashboard.setupIncomplete")}</p>
      <Link
        href={`/setup?entryProduct=booking&returnTo=%2Fdashboard&propertyId=${encodeURIComponent(propertyId)}`}
        className="shrink-0 font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4 hover:decoration-amber-700"
      >
        {t("dashboard.resumeSetup")}
      </Link>
    </div>
  );
}
