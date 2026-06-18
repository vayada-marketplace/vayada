"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (searchParams.get("expired") === "true") {
      setSessionExpired(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("auth") !== "callback") {
      authService.startHostedLogin();
      return;
    }
    let cancelled = false;
    setIsSubmitting(true);
    authService
      .refreshSession()
      .then(() => {
        if (!cancelled) router.push("/dashboard");
      })
      .catch((error) => {
        if (!cancelled) {
          setSubmitError(
            error instanceof Error ? error.message : "Login failed. Please try again.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsSubmitting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <span className="text-white font-bold text-[16px]">V</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vayada Admin</h1>
          <p className="text-[13px] text-gray-500 mt-1">Redirecting to sign in...</p>
        </div>

        {(sessionExpired || submitError) && (
          <div className="space-y-5">
            {sessionExpired && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 font-medium">
                  Your session has expired. Please sign in again.
                </p>
              </div>
            )}
            {submitError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm text-red-800 font-medium">{submitError}</p>
              </div>
            )}
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
