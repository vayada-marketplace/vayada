"use client";
import { useTranslation } from "@/lib/i18n";

import { useCallback, useEffect, useRef, useState } from "react";
import { authService } from "@/services/auth";
import { isAuthOrganizationSelectionResponse } from "@/services/auth/sessionStore";
import { settingsService } from "@/services/settings";
import { resolveHandoffRouting, type HandoffRoutingInput } from "./routeAfterHandoff";
import {
  isSafeRelativeReturnTo,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "@vayada/product-onboarding/returnTo";
import {
  BrowserAuthHandoffError,
  redeemBrowserAuthHandoff,
  useSingleFlightGuard,
} from "@vayada/product-onboarding";

export default function HandoffPage() {
  const { t } = useTranslation();
  const [retryable, setRetryable] = useState(false);
  const beginRedemption = useSingleFlightGuard();
  // Set once the session is in place: Retry re-runs the routing instead of reloading, so a
  // redeemed handoff keeps its target when the hotel list is temporarily unavailable.
  const pendingRouting = useRef<HandoffRoutingInput | null>(null);

  const routeWithHotels = useCallback(async (input: HandoffRoutingInput) => {
    const outcome = await resolveHandoffRouting(input, {
      listHotels: () => settingsService.listHotels(),
      storage: localStorage,
    });
    if (outcome.kind === "retry") {
      pendingRouting.current = input;
      setRetryable(true);
      return;
    }
    pendingRouting.current = null;
    window.location.href = outcome.href;
  }, []);

  const retry = () => {
    const input = pendingRouting.current;
    if (!input) {
      window.location.reload();
      return;
    }
    setRetryable(false);
    void routeWithHotels(input).catch(() => setRetryable(true));
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!beginRedemption()) return;

    // Auth data arrives in the URL hash so it never hits server logs.
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const code = hashParams.get("code");
    const token = hashParams.get("token");
    const expiresAt = hashParams.get("expires_at");
    const userData = hashParams.get("user");
    let handoffHotelId = hashParams.get("hotel_id");
    let propertyId = hashParams.get("property_id");
    let organizationId = hashParams.get("organization_id")?.trim() || null;
    let workosOrganizationId = hashParams.get("workos_organization_id")?.trim() || null;
    let organizationSelectionPath = organizationSelectionLoginPath(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    );

    // Optional `?redirect=...` query param tells us where to go after
    // auth. Used by the PMS header's "Add Property" button which
    // needs to land on /setup?mode=add instead of /dashboard.
    const queryParams = new URLSearchParams(window.location.search);
    const redirectParam = queryParams.get("redirect");
    // Only honor same-origin relative paths — never trust an arbitrary URL
    let safeRedirect = isSafeRelativeReturnTo(redirectParam) ? redirectParam : null;

    void (async () => {
      if (code) {
        try {
          const handoff = await redeemBrowserAuthHandoff({
            code,
            targetSurface: "booking-admin",
          });
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
          organizationSelectionPath = organizationSelectionLoginPath(
            window.location.pathname,
            window.location.search,
            "",
          );
          handoffHotelId = handoff.routingHints.hotelId ?? null;
          propertyId = handoff.routingHints.propertyId ?? null;
          organizationId = handoff.routingHints.organizationId ?? null;
          workosOrganizationId = handoff.routingHints.workosOrganizationId ?? null;
          safeRedirect = handoff.targetPath;
          if (!(await authService.ensureSession()))
            throw new Error(t("admin.handoffSessionUnavailable"));
        } catch (error) {
          if (error instanceof BrowserAuthHandoffError && error.retryable) {
            setRetryable(true);
            return;
          }
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
          window.location.replace(
            organizationSelectionLoginPath(window.location.pathname, window.location.search, ""),
          );
          return;
        }
      } else if (!authService.isAuthKitEnabled() && token && expiresAt) {
        localStorage.setItem("access_token", token);
        localStorage.setItem("token_expires_at", expiresAt);
      } else if (!authService.isAuthKitEnabled()) {
        if (!(await authService.ensureSession())) {
          window.location.href = organizationSelectionPath;
          return;
        }
      } else {
        try {
          let session = await authService.refreshSession();
          if (isAuthOrganizationSelectionResponse(session)) {
            const organization = organizationId
              ? session.organizations.find(
                  (candidate) => candidate.organizationId === organizationId,
                )
              : workosOrganizationId
                ? session.organizations.find(
                    (candidate) => candidate.workosOrganizationId === workosOrganizationId,
                  )
                : session.organizations.length === 1
                  ? session.organizations[0]
                  : undefined;

            if (
              !organization ||
              (workosOrganizationId && organization.workosOrganizationId !== workosOrganizationId)
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }

            session = await authService.refreshSession(
              workosOrganizationId ?? organization.workosOrganizationId,
            );
            if (
              isAuthOrganizationSelectionResponse(session) ||
              (organizationId && session.organizationId !== organizationId) ||
              (workosOrganizationId && session.workosOrganizationId !== workosOrganizationId)
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }
          } else if (
            (organizationId && session.organizationId !== organizationId) ||
            (workosOrganizationId && session.workosOrganizationId !== workosOrganizationId)
          ) {
            if (!workosOrganizationId) {
              window.location.href = missingOrganizationHandoffLoginPath();
              return;
            }
            session = await authService.refreshSession(workosOrganizationId);
            if (
              isAuthOrganizationSelectionResponse(session) ||
              (organizationId && session.organizationId !== organizationId) ||
              session.workosOrganizationId !== workosOrganizationId
            ) {
              window.location.href = organizationSelectionPath;
              return;
            }
          }
        } catch {
          window.location.href = organizationSelectionPath;
          return;
        }
      }

      if (!authService.isAuthKitEnabled() && token && expiresAt && userData) {
        try {
          const user = JSON.parse(decodeURIComponent(userData));
          localStorage.setItem("isLoggedIn", "true");
          localStorage.setItem("userId", user.id);
          localStorage.setItem("userEmail", user.email);
          localStorage.setItem("userName", user.name);
          localStorage.setItem("userType", user.type);
          localStorage.setItem("userStatus", user.status);
          localStorage.setItem("user", JSON.stringify(user));
        } catch {
          /* ignore */
        }
      }

      await routeWithHotels({
        safeRedirect,
        propertyId: propertyId?.trim() || null,
        handoffHotelId: handoffHotelId?.trim() || null,
      });
    })().catch(() => {
      window.location.href = organizationSelectionPath;
    });
  }, [beginRedemption, routeWithHotels, t]);

  if (retryable) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center"
        role="status"
      >
        <p className="text-sm font-medium text-gray-700">
          {t("admin.yourSessionTransferIsTemporarilyUnavailable")}
        </p>
        <button
          type="button"
          onClick={retry}
          className="rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white"
        >
          {t("dashboard.pageViewsModal.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div
        className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"
        role="status"
        aria-label={t("admin.transferringYourSession")}
      />
    </div>
  );
}
