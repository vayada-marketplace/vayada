"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { isSetupComplete } from "@/lib/utils/setupStatus";
import { settingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";

function LoginContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [submitError, setSubmitError] = useState(
    searchParams.get("expired") === "true" ? t("auth.login.errorSessionExpired") : "",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectAfterLogin = useCallback(
    async (loginResponse: { is_superadmin?: boolean }) => {
      if (loginResponse.is_superadmin) {
        localStorage.setItem("setupComplete", "true");
        router.push("/manage-hotels");
        return;
      }

      const complete = await isSetupComplete();
      if (!complete) {
        localStorage.setItem("setupComplete", "false");
        router.push("/setup");
        return;
      }

      const hotelList = await settingsService.listHotels();
      localStorage.setItem("setupComplete", "true");

      if (hotelList.length > 1) {
        localStorage.removeItem("selectedHotelId");
        router.push("/choose-property");
        return;
      }

      if (hotelList.length === 1) {
        localStorage.setItem("selectedHotelId", hotelList[0].id);
      }
      router.push("/dashboard");
    },
    [router],
  );

  useEffect(() => {
    if (searchParams.get("auth") !== "callback") {
      authService.startHostedLogin();
      return;
    }
    let cancelled = false;
    setIsSubmitting(true);
    authService
      .refreshSession()
      .then(async () => {
        if (!cancelled) {
          await redirectAfterLogin({});
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setSubmitError(error instanceof Error ? error.message : t("auth.login.errorUnexpected"));
      })
      .finally(() => {
        if (!cancelled) {
          setIsSubmitting(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, searchParams, t]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">B</span>
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

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginContent />
    </Suspense>
  );
}
