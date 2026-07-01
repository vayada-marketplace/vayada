"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { useTranslation } from "@/lib/i18n";

type LoginContentProps = {
  returnTo?: string;
};

export function LoginContent({ returnTo = "/dashboard" }: LoginContentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  const redirectAfterLogin = useCallback(async () => {
    const decision = await resolvePmsSetupGuard(returnTo);
    localStorage.setItem(
      "pmsSetupComplete",
      decision.action === "enter_product" ? "true" : "false",
    );
    router.push(decision.action === "enter_product" ? returnTo : decision.redirectPath);
  }, [returnTo, router]);

  const handleOrganizationSelect = useCallback(
    async (workosOrganizationId: string) => {
      setSubmitError("");
      setIsSubmitting(true);
      try {
        const response = await authService.refreshSession(workosOrganizationId);
        if (isAuthOrganizationSelectionResponse(response)) {
          setOrganizationSelection(response);
          return;
        }
        await redirectAfterLogin();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : t("auth.login.unexpectedError"));
      } finally {
        setIsSubmitting(false);
      }
    },
    [redirectAfterLogin, t],
  );

  useEffect(() => {
    let cancelled = false;
    setIsSubmitting(true);
    authService
      .refreshSession()
      .then(async (response) => {
        if (cancelled) return;
        if (isAuthOrganizationSelectionResponse(response)) {
          setOrganizationSelection(response);
          return;
        }
        await redirectAfterLogin();
      })
      .catch((error) => {
        if (cancelled) return;
        setSubmitError(error instanceof Error ? error.message : t("auth.login.unexpectedError"));
      })
      .finally(() => {
        if (!cancelled) {
          setIsSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, t]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
              <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
              <path d="M3 7h18" />
              <path d="M8 11h8" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">
            {organizationSelection ? t("auth.login.chooseHotelGroup") : t("auth.login.title")}
          </h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {organizationSelection
              ? t("auth.login.chooseHotelGroupSubtitle")
              : t("auth.login.redirecting")}
          </p>
        </div>

        {organizationSelection && (
          <div className="mb-5 space-y-2">
            {organizationSelection.organizations.map((organization) => (
              <button
                key={organization.workosOrganizationId}
                type="button"
                onClick={() => handleOrganizationSelect(organization.workosOrganizationId)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-gray-200 px-4 py-3 text-left text-sm font-medium text-gray-900 transition-colors hover:border-primary-300 hover:bg-primary-50 disabled:opacity-60"
              >
                {organization.displayName}
              </button>
            ))}
          </div>
        )}

        {submitError && (
          <div className="space-y-5">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-800 font-medium">{submitError}</p>
            </div>
            <button
              type="button"
              onClick={() => authService.startHostedLogin(undefined, returnTo)}
              disabled={isSubmitting}
              className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-60"
            >
              Sign in again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
