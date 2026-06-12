"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { ApiErrorResponse } from "@/services/api/client";
import { checkPmsSetupStatus } from "@/lib/utils/setupStatus";
import { pmsSettingsService } from "@/services/settings";
import LoginForm from "@/components/auth/LoginForm";
import { useTranslation } from "@/lib/i18n";

function LoginContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [submitError, setSubmitError] = useState(
    searchParams.get("expired") === "true" ? t("auth.login.sessionExpiredBanner") : "",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginHint, setLoginHint] = useState("");
  const useLegacyLogin =
    !authService.isAuthKitEnabled() ||
    (authService.isLegacyFallbackEnabled() && searchParams.get("legacy") === "true");

  const redirectAfterLogin = useCallback(async () => {
    const status = await checkPmsSetupStatus();

    if (!status || !status.registered || !status.setupComplete) {
      localStorage.setItem("pmsSetupComplete", "false");
      router.push("/setup");
      return;
    }

    localStorage.setItem("pmsSetupComplete", "true");

    // Multi-hotel users get the property picker so they explicitly
    // choose which property to manage instead of being dropped into
    // an arbitrary "last-used" dashboard. Single-hotel users skip it.
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
      // If the hotel list fails, fall through to dashboard — the
      // header's own listHotels call will re-populate state there.
    }
    router.push("/dashboard");
  }, [router]);

  useEffect(() => {
    if (!authService.isAuthKitEnabled() || searchParams.get("auth") !== "callback") {
      return;
    }
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
  }, [redirectAfterLogin, searchParams, t]);

  const handleLogin = async (email: string, password: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      await authService.login({ email, password });
      await redirectAfterLogin();
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError(t("auth.login.invalidCredentials"));
        } else if (error.status === 403) {
          setSubmitError(t("auth.login.accountSuspended"));
        } else if (error.status === 422) {
          const detail = error.data.detail;
          if (Array.isArray(detail)) {
            setSubmitError(detail.map((e) => e.msg).join(". "));
          } else {
            setSubmitError(detail || t("auth.login.validationError"));
          }
        } else {
          setSubmitError(t("auth.login.unexpectedError"));
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError(t("auth.login.unexpectedError"));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHostedLogin = () => {
    authService.startHostedLogin(loginHint.trim() || undefined);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        {/* Logo / Title */}
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
          <p className="text-[13px] text-gray-500 mt-1">
            {useLegacyLogin ? t("auth.login.subtitle") : "Sign in with WorkOS AuthKit"}
          </p>
        </div>

        {!useLegacyLogin ? (
          <div className="space-y-5">
            {submitError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm text-red-800 font-medium">{submitError}</p>
              </div>
            )}
            <div>
              <label htmlFor="loginHint" className="block text-sm font-medium text-gray-700 mb-1.5">
                Email address
              </label>
              <input
                id="loginHint"
                type="email"
                value={loginHint}
                onChange={(event) => setLoginHint(event.target.value)}
                placeholder="hotel@example.com"
                autoComplete="email"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm text-gray-900"
              />
            </div>
            <button
              type="button"
              onClick={handleHostedLogin}
              disabled={isSubmitting}
              className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-60"
            >
              Continue with WorkOS
            </button>
            {authService.isLegacyFallbackEnabled() && (
              <div className="text-center">
                <a
                  href="/login?legacy=true"
                  className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                >
                  Use legacy password fallback
                </a>
              </div>
            )}
          </div>
        ) : (
          <LoginForm
            onSubmit={handleLogin}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onErrorClear={() => setSubmitError("")}
            showForgotPassword={false}
            showRegister={false}
          />
        )}

        {/* Sign up link */}
        {useLegacyLogin && (
          <p className="text-center text-[13px] text-gray-500 mt-5">
            {t("auth.login.noAccount")}{" "}
            <a href="/register" className="text-primary-600 hover:text-primary-700 font-medium">
              {t("auth.login.signUp")}
            </a>
          </p>
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
