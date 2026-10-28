"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buildSharedHotelSetupRedirectPath, setupExitPropertyId } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";

/**
 * Shown after "Exit setup" brings a hotel back here while its setup is still unfinished (VAY-2249).
 * `hidden` unless the setup checklist couldn't load (VAY-2247): the checklist shows what's left, so
 * the banner answers from the exit marker alone, as PMS does (VAY-2175). The marker is still dropped.
 */
export function ResumeSetupBanner({ hidden = false }: { hidden?: boolean } = {}) {
  const { t } = useTranslation();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  // Read once: the marker is gone from the URL after the first run (and Strict Mode runs effects twice).
  const exitPropertyId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (exitPropertyId.current === undefined) {
      exitPropertyId.current = setupExitPropertyId(
        `${window.location.pathname}${window.location.search}`,
      );
      // The layout has already entered this property; drop the marker so a reload or a hotel
      // switch doesn't point the banner at it again. Not with router.replace: in a production
      // build Next.js 16 commits the cached route's URL, marker included (VAY-2330). Next.js
      // syncs its router with a plain history update.
      if (exitPropertyId.current) window.history.replaceState(null, "", "/dashboard");
    }
    setPropertyId(exitPropertyId.current);
  }, []);

  if (!propertyId || hidden) return null;
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p>{t("dashboard.setupIncomplete")}</p>
      <Link
        href={buildSharedHotelSetupRedirectPath({
          entryProduct: "booking",
          returnProduct: "booking",
          returnTo: "/dashboard",
          propertyId,
        })}
        className="shrink-0 font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4 hover:decoration-amber-700"
      >
        {t("dashboard.resumeSetup")}
      </Link>
    </div>
  );
}
