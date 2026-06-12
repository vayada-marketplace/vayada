"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { ApiErrorResponse } from "@/services/api/client";
import LoginForm from "@/components/auth/LoginForm";
import TotpForm from "@/components/auth/TotpForm";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [totpSession, setTotpSession] = useState<string | null>(null);
  const [loginHint, setLoginHint] = useState("");
  const useLegacyLogin = !authService.isAuthKitEnabled() || searchParams.get("legacy") === "true";

  useEffect(() => {
    if (searchParams.get("expired") === "true") {
      setSessionExpired(true);
    }
  }, [searchParams]);

  const handleLogin = async (email: string, password: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      const response = await authService.login({ email, password });

      if (response.requires_totp) {
        setTotpSession(response.totp_session!);
        setIsSubmitting(false);
        return;
      }

      router.push("/dashboard");
    } catch (error) {
      setIsSubmitting(false);

      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError("Invalid email or password");
        } else if (error.status === 403) {
          const detail = error.data.detail as { message?: string } | string;
          setSubmitError(
            typeof detail === "object"
              ? (detail.message ?? "Your account has been suspended. Please contact support.")
              : "Your account has been suspended. Please contact support.",
          );
        } else if (error.status === 422) {
          const detail = error.data.detail;
          if (Array.isArray(detail)) {
            setSubmitError(detail.map((e) => e.msg).join(". "));
          } else {
            setSubmitError((detail as string) || "Validation error");
          }
        } else {
          setSubmitError((error.data.detail as string) || "Login failed. Please try again.");
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError("Network error. Please check your connection and try again.");
      }
    }
  };

  const handleHostedLogin = () => {
    authService.startHostedLogin(loginHint.trim() || undefined);
  };

  const handleTotpVerify = async (code: string) => {
    setSubmitError("");
    setIsSubmitting(true);

    try {
      await authService.verifyTotp(totpSession!, code);
      router.push("/dashboard");
    } catch (error) {
      setIsSubmitting(false);

      if (error instanceof ApiErrorResponse) {
        if (error.status === 401) {
          setSubmitError("Invalid code. Please try again.");
        } else if (error.status === 403) {
          const detail = error.data.detail as { message?: string } | string;
          setSubmitError(
            typeof detail === "object"
              ? (detail.message ?? "Too many attempts. Please wait and try again.")
              : detail,
          );
        } else {
          setSubmitError((error.data.detail as string) || "Verification failed.");
        }
      } else if (error instanceof Error) {
        setSubmitError(error.message);
      } else {
        setSubmitError("Network error. Please check your connection and try again.");
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">V</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vayada Admin</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {totpSession
              ? "Two-factor authentication"
              : useLegacyLogin
                ? "Sign in with your legacy admin password"
                : "Sign in with WorkOS AuthKit"}
          </p>
        </div>

        {!useLegacyLogin ? (
          <div className="space-y-5">
            {sessionExpired && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 font-medium">
                  Your session has expired. Please sign in again.
                </p>
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
                placeholder="admin@example.com"
                autoComplete="email"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm text-gray-900"
              />
            </div>
            <button
              type="button"
              onClick={handleHostedLogin}
              className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
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
            sessionExpired={sessionExpired}
            showRegister={false}
            showForgotPassword={!authService.isAuthKitEnabled()}
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
