"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import {
  isAuthOrganizationSelectionResponse,
  type AuthOrganizationSelectionResponse,
} from "@/services/auth/sessionStore";
import { checkProfileStatus } from "@/lib/utils";
import { resolveMarketplaceSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { getPostLoginProfileRedirect } from "@/lib/utils/profileRedirect";
import type { UserType } from "@/lib/types";

type LoginContentProps = {
  returnTo?: string;
};

export function LoginContent({ returnTo = ROUTES.MARKETPLACE }: LoginContentProps) {
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [organizationSelection, setOrganizationSelection] =
    useState<AuthOrganizationSelectionResponse | null>(null);

  const redirectAfterLogin = useCallback(async () => {
    const userType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
    let redirectPath: string = ROUTES.MARKETPLACE;

    if (userType === "hotel") {
      const decision = await resolveMarketplaceSetupGuard(returnTo);
      localStorage.setItem(
        STORAGE_KEYS.PROFILE_COMPLETE,
        String(decision.action === "enter_product"),
      );
      router.push(decision.action === "enter_product" ? returnTo : decision.redirectPath);
      return;
    }

    if (userType === "creator") {
      const profileStatus = await checkProfileStatus(userType);
      const decision = getPostLoginProfileRedirect(userType, profileStatus);
      redirectPath = decision.redirectPath;
      if (decision.profileComplete !== null) {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, String(decision.profileComplete));
      }
    }

    router.push(redirectPath);
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
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      } finally {
        setIsSubmitting(false);
      }
    },
    [redirectAfterLogin],
  );

  useEffect(() => {
    let cancelled = false;
    setSubmitError("");
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
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <Image
            src="/vayada-logo.png"
            alt="vayada"
            width={120}
            height={40}
            className="mx-auto mb-4 h-10 w-auto"
            priority
          />
          <h1 className="text-xl font-bold text-gray-900">
            {organizationSelection ? "Choose workspace" : "Signing you in"}
          </h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {organizationSelection
              ? "Select where you want to continue."
              : "Finishing secure sign in..."}
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
              className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
            >
              Sign in again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
