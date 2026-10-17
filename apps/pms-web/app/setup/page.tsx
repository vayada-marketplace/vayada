"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  buildSharedHotelSetupRedirectPath,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
} from "@vayada/product-onboarding";
import { organizationSelectionLoginPath } from "@vayada/product-onboarding/returnTo";
import { authService } from "@/services/auth";
import {
  getAuthCsrfToken,
  hasAuthenticatedSession,
  hasHotelAccessMarker,
  isAuthKitLoginEnabled,
  isAuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import {
  classifyPmsSessionFailure,
  pmsLoginUrlForSetup,
  resolveSharedHotelSetupHandoff,
} from "@/lib/utils/setupHandoff";
import { useTranslation } from "@/lib/i18n";

export default function PmsSetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <CanonicalSetupRedirect />
    </Suspense>
  );
}

type PmsSessionState = "signed_in" | "signed_out" | "organization_selection" | "unavailable";

// A direct visit has no session in memory yet; the session read also yields the CSRF token.
async function readPmsSession(): Promise<PmsSessionState> {
  if (!isAuthKitLoginEnabled()) {
    return (await authService.ensureSession()) ? "signed_in" : "signed_out";
  }
  if (hasAuthenticatedSession() && hasHotelAccessMarker()) return "signed_in";
  try {
    const session = await authService.refreshSession();
    return isAuthOrganizationSelectionResponse(session) ? "organization_selection" : "signed_in";
  } catch (error) {
    return classifyPmsSessionFailure(error);
  }
}

/**
 * The PMS's local setup alias. Booking Admin hosts the wizard (VAY-2261); the alias keeps the
 * entry product, the return path and the add-property mode, and moves the browser there with the
 * one-time session handoff so the user stays signed in (VAY-2266). Without a PMS session the
 * user signs in here first and comes back to the alias.
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
    const controller = new AbortController();
    setRetryable(false);
    void (async () => {
      const aliasPath = `${window.location.pathname}${window.location.search}`;
      const session = await readPmsSession();
      if (controller.signal.aborted) return;
      if (session === "signed_out") {
        window.location.replace(pmsLoginUrlForSetup(aliasPath));
        return;
      }
      if (session === "organization_selection") {
        window.location.replace(
          organizationSelectionLoginPath(window.location.pathname, window.location.search, ""),
        );
        return;
      }
      if (session === "unavailable") {
        setRetryable(true);
        return;
      }
      const handoff = await resolveSharedHotelSetupHandoff({
        targetPath,
        csrfToken: getAuthCsrfToken(),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (handoff.kind === "retryable") {
        setRetryable(true);
        return;
      }
      window.location.replace(handoff.destination);
    })().catch((error) => {
      if (controller.signal.aborted) return;
      console.error("Unable to open the hotel setup:", error);
      setRetryable(true);
    });
    return () => controller.abort();
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
