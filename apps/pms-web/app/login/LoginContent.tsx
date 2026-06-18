"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { checkPmsSetupStatus } from "@/lib/utils/setupStatus";
import { pmsSettingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";

export function LoginContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectAfterLogin = useCallback(async () => {
    const status = await checkPmsSetupStatus();

    if (!status || !status.registered || !status.setupComplete) {
      localStorage.setItem("pmsSetupComplete", "false");
      router.push("/setup");
      return;
    }

    localStorage.setItem("pmsSetupComplete", "true");

    try {
      const hotels = await pmsSettingsService.listHotels();
      if (hotels.length > 1) {
        localStorage.removeItem("selectedHotelId");
        router.push("/choose-property");
        return;
      }
      if (hotels.length === 1) {
        localStorage.setItem("selectedHotelId", hotels[0].id);
      }
    } catch {
      // The dashboard header will retry the hotel list and restore state.
    }
    router.push("/dashboard");
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    setIsSubmitting(true);
    authService
      .refreshSession()
      .then(async () => {
        if (!cancelled) {
          await redirectAfterLogin();
        }
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
          <h1 className="text-xl font-bold text-gray-900">{t("auth.login.title")}</h1>
          <p className="text-[13px] text-gray-500 mt-1">Redirecting to sign in...</p>
        </div>

        {submitError && (
          <div className="space-y-5">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-800 font-medium">{submitError}</p>
            </div>
            <button
              type="button"
              onClick={() => authService.startHostedLogin()}
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
