"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { ApiErrorResponse } from "@/services/api/client";
import { isSetupComplete } from "@/lib/utils/setupStatus";
import { settingsService } from "@/services/settings";
import LoginForm from "@/components/auth/LoginForm";
import TotpForm from "@/components/auth/TotpForm";
import { useTranslation } from "@/lib/i18n";

function LoginContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [submitError, setSubmitError] = useState(
    searchParams.get("expired") === "true" ? t("auth.login.errorSessionExpired") : "",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [totpSession, setTotpSession] = useState<string | null>(null);
  const [loginHint, setLoginHint] = useState("");
  const useLegacyLogin =
    !authService.isAuthKitEnabled() ||
    (authService.isLegacyFallbackEnabled() && searchParams.get("legacy") === "true");

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
    if (!authService.isAuthKitEnabled() || searchParams.get("auth") !== "callback") {
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

  const handleLogin = async (email: string, password: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      const loginResponse = await authService.login({ email, password });

      if (loginResponse.requires_totp) {
        setTotpSession(loginResponse.totp_session!);
        setIsSubmitting(false);
        return;
      }

      await redirectAfterLogin(loginResponse);
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError(t("auth.login.errorInvalidCredentials"));
        } else if (error.status === 403) {
          const detail = error.data.detail as { message?: string } | string;
          setSubmitError(
            typeof detail === "object"
              ? (detail.message ?? t("auth.login.errorSuspended"))
              : t("auth.login.errorSuspended"),
          );
        } else if (error.status === 422) {
          const detail = error.data.detail;
          if (Array.isArray(detail)) {
            setSubmitError(detail.map((e) => e.msg).join(". "));
          } else {
            setSubmitError(detail || t("auth.login.errorValidation"));
          }
        } else {
          setSubmitError(t("auth.login.errorUnexpected"));
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError(t("auth.login.errorUnexpected"));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHostedLogin = () => {
    authService.startHostedLogin(loginHint.trim() || undefined);
  };

  const handleTotpVerify = async (code: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      const loginResponse = await authService.verifyTotp(totpSession!, code);
      await redirectAfterLogin(loginResponse);
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError(t("auth.totp.errorInvalid"));
        } else if (error.status === 403) {
          const detail = error.data.detail as { message?: string } | string;
          const msg = typeof detail === "object" ? detail.message : detail;
          setSubmitError(msg || t("auth.totp.errorTooMany"));
        } else {
          setSubmitError(t("auth.totp.errorUnexpected"));
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError(t("auth.totp.errorUnexpected"));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">{t("auth.login.title")}</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {totpSession
              ? t("auth.totp.subtitle")
              : useLegacyLogin
                ? t("auth.login.subtitle")
                : "Sign in with WorkOS AuthKit"}
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
        ) : totpSession ? (
          <TotpForm
            onSubmit={handleTotpVerify}
            onCancel={() => {
              setTotpSession(null);
              setSubmitError("");
            }}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onErrorClear={() => setSubmitError("")}
          />
        ) : (
          <LoginForm
            onSubmit={handleLogin}
            isSubmitting={isSubmitting}
            submitError={submitError}
            onErrorClear={() => setSubmitError("")}
          />
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
