"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import { checkProfileStatus } from "@/lib/utils";
import { getPostLoginProfileRedirect } from "@/lib/utils/profileRedirect";
import type { UserType } from "@/lib/types";

export function LoginContent() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");

  const redirectAfterLogin = useCallback(async () => {
    const userType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
    let redirectPath: string = ROUTES.MARKETPLACE;

    if (userType === "creator" || userType === "hotel") {
      const profileStatus = await checkProfileStatus(userType);
      const decision = getPostLoginProfileRedirect(userType, profileStatus);
      redirectPath = decision.redirectPath;
      if (decision.profileComplete !== null) {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, String(decision.profileComplete));
      }
    }

    router.push(redirectPath);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    setSubmitError("");
    authService
      .refreshSession()
      .then(async () => {
        if (!cancelled) {
          await redirectAfterLogin();
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
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
          <h1 className="text-xl font-bold text-gray-900">Signing you in</h1>
          <p className="text-[13px] text-gray-500 mt-1">Finishing secure sign in...</p>
        </div>

        {submitError && (
          <div className="space-y-5">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-800 font-medium">{submitError}</p>
            </div>
            <button
              type="button"
              onClick={() => authService.startHostedLogin()}
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
