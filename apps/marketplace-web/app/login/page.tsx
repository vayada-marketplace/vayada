"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import { checkProfileStatus } from "@/lib/utils";
import { getPostLoginProfileRedirect } from "@/lib/utils/profileRedirect";
import type { UserType } from "@/lib/types";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      if (redirectPath === ROUTES.PROFILE_COMPLETE) {
        router.push(redirectPath);
        return;
      }
    }

    router.push(redirectPath);
  }, [router]);

  useEffect(() => {
    if (searchParams.get("expired") === "true") {
      setSessionExpired(true);
    }
    if (searchParams.get("auth") !== "callback") return;

    let cancelled = false;
    setIsSubmitting(true);
    setSubmitError("");
    authService
      .refreshSession()
      .then(async () => {
        if (cancelled) return;
        await redirectAfterLogin();
      })
      .catch((error) => {
        if (cancelled) return;
        setSubmitError(error instanceof Error ? error.message : "Login failed. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setIsSubmitting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [redirectAfterLogin, searchParams]);

  const handleLogin = async () => {
    setSubmitError("");

    setIsSubmitting(true);
    try {
      authService.startHostedLogin();
      window.setTimeout(() => setIsSubmitting(false), 5000);
    } catch {
      setIsSubmitting(false);
      setSubmitError("Failed to start login. Please try again.");
    }
  };

  const retryLogin = () => authService.startHostedLogin();

  return (
    <div className="min-h-screen flex">
      {/* Left Side - Sign In Form (50% width) */}
      <div className="w-full lg:w-1/2 bg-white flex items-center justify-center p-8 relative">
        {/* Back to Home Button */}
        <Link
          href={ROUTES.HOME}
          className="absolute top-6 left-6 flex items-center gap-2 text-gray-600 hover:text-primary-600 transition-colors"
        >
          <ArrowLeftIcon className="w-5 h-5" />
          <span className="text-sm font-medium">Back to Home</span>
        </Link>

        <div className="w-full max-w-md">
          {/* Logo */}
          <div className="mb-8">
            <img src="/vayada-logo.png" alt="vayada" className="h-12 mb-6" />
          </div>

          {/* Title */}
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Sign in</h1>
          <p className="text-gray-600 mb-2">Enter your credentials to access your account</p>
          <p className="text-sm text-gray-500 mb-8">
            Looking for the PMS & Booking Engine?{" "}
            <Link
              href={`${ROUTES.CHOOSE_PRODUCT}?choose=1`}
              className="font-medium text-primary-600 hover:text-primary-700"
            >
              Choose a different product
            </Link>
          </p>

          <div className="space-y-5">
            {sessionExpired && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 font-medium">
                  Your session has expired. Please login again.
                </p>
              </div>
            )}

            {submitError && (
              <div className="space-y-3">
                <div className="bg-red-50 border-2 border-red-300 rounded-lg p-4">
                  <p className="text-sm text-red-800 font-semibold">{submitError}</p>
                </div>
                <button
                  type="button"
                  onClick={retryLogin}
                  className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
                >
                  Sign in again
                </button>
              </div>
            )}

            {!submitError && (
              <button
                type="button"
                onClick={handleLogin}
                disabled={isSubmitting}
                className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? "Redirecting..." : "Continue with WorkOS"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right Side - Image (50% width) */}
      <div className="hidden lg:block lg:w-1/2 relative">
        <div className="absolute inset-0">
          <img
            src="/hotel-hero.JPG"
            alt="Luxury hotel resort"
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex" />}>
      <LoginContent />
    </Suspense>
  );
}
