"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buildSharedHotelSetupRedirectPath, setupExitPropertyId } from "@vayada/product-onboarding";
import { useTranslation } from "@/lib/i18n";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

/**
 * Shown after "Exit setup" brings a hotel back here while its setup is still unfinished (VAY-2249).
 * `hidden` while the setup checklist shows instead (VAY-2247): the exit marker is still dropped.
 */
export function ResumeSetupBanner({ hidden = false }: { hidden?: boolean } = {}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  // Read once: the marker is gone from the URL after the first run (and Strict Mode runs effects twice).
  const exitPropertyId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (exitPropertyId.current === undefined) {
      exitPropertyId.current = setupExitPropertyId(
        `${window.location.pathname}${window.location.search}`,
      );
      // The layout has already entered this property; drop the marker so a reload or a hotel
      // switch doesn't point the banner at it again.
      if (exitPropertyId.current) router.replace("/dashboard", { scroll: false });
    }
    const id = exitPropertyId.current;
    if (!id) return;
    let active = true;
    // "Finish for now" leaves setup with the same marker, so ask whether anything is left.
    void sharedHotelSetupApi
      .getStatus({ entryProduct: "booking", propertyId: id })
      .then((status) => {
        const plan = status.setupPlan;
        if (active && plan && plan.ownerProgress.complete < plan.ownerProgress.total) {
          setPropertyId(id);
        }
      })
      .catch(() => {
        // Without a readable status there's nothing reliable to say; the dashboard stays as is.
      });
    return () => {
      active = false;
    };
  }, [router]);

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
