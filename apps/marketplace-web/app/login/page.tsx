"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { authService } from "@/services/auth";
import { checkProfileStatus } from "@/lib/utils";
import type { UserType } from "@/lib/types";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectAfterLogin = useCallback(async () => {
    const userType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
    if (userType === "creator" || userType === "hotel") {
      try {
        const profileStatus = await checkProfileStatus(userType);
        if (profileStatus && profileStatus.profile_complete) {
          localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "true");
        } else {
          localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
          router.push(ROUTES.PROFILE_COMPLETE);
          return;
        }
      } catch (error) {
        console.error("Failed to check profile status:", error);
      }
    }

    router.push(ROUTES.MARKETPLACE);
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

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError("");
    setEmailError("");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError("Please enter a valid email address");
      return;
    }

    setIsSubmitting(true);
    try {
      authService.startHostedLogin(email);
      window.setTimeout(() => setIsSubmitting(false), 5000);
    } catch {
      setIsSubmitting(false);
      setSubmitError("Failed to start login. Please try again.");
    }
  };

  const retryLogin = () => authService.startHostedLogin(email || undefined);

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

          <form onSubmit={handleLogin} className="space-y-5">
            {sessionExpired && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800 font-medium">
                  Your session has expired. Please login again.
                </p>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                type="email"
                name="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) setEmailError("");
                  if (submitError) setSubmitError("");
                }}
                required
                placeholder="name@example.com"
                autoComplete="email"
                className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm text-gray-900 ${
                  emailError ? "border-red-300 ring-1 ring-red-300" : "border-gray-300"
                }`}
              />
              {emailError && <p className="mt-1 text-sm text-red-600">{emailError}</p>}
            </div>

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
                type="submit"
                disabled={isSubmitting}
                className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? "Redirecting..." : "Continue with WorkOS"}
              </button>
            )}
          </form>
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
