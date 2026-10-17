"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  buildSharedHotelSetupRedirectPath,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
} from "@vayada/product-onboarding";
import { authService } from "@/services/auth";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import { resolveSharedHotelSetupHandoff } from "@/lib/utils/setupHandoff";
import { useTranslation } from "@/lib/i18n";

export default function PmsSetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <CanonicalSetupRedirect />
    </Suspense>
  );
}

/**
 * The PMS's local setup alias. Booking Admin hosts the wizard (VAY-2261); the alias keeps the
 * entry product, the return path and the add-property mode, and moves the browser there with the
 * one-time session handoff so the user stays signed in (VAY-2266).
 */
function CanonicalSetupRedirect() {
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [retryable, setRetryable] = useState(false);
  const targetPath = useMemo(
    () =>
      buildSharedHotelSetupRedirectPath({
        entryProduct: parseSharedHotelSetupEntryProduct(searchParams.get("entryProduct")) ?? "pms",
        returnProduct: "pms",
        returnTo: safeSharedHotelSetupReturnTo(searchParams.get("returnTo"), "/dashboard"),
        propertyId: searchParams.get("propertyId"),
        mode: searchParams.get("mode") === "add" ? "add" : undefined,
      }),
    [searchParams],
  );

  useEffect(() => {
    let cancelled = false;
    setRetryable(false);
    void (async () => {
      // A direct visit has no session in memory yet; the session read also yields the CSRF token.
      const signedIn = await authService.ensureSession();
      const handoff = await resolveSharedHotelSetupHandoff({
        targetPath,
        csrfToken: signedIn ? getAuthCsrfToken() : null,
      });
      if (cancelled) return;
      if (handoff.kind === "retryable") {
        setRetryable(true);
        return;
      }
      window.location.replace(handoff.destination);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, targetPath]);

  if (retryable) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium text-gray-700">{t("handoff.temporarilyUnavailable")}</p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white"
        >
          {t("auth.chooseProperty.retry")}
        </button>
      </div>
    );
  }

  return <SetupLoading />;
}

function SetupLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
    </div>
  );
}
