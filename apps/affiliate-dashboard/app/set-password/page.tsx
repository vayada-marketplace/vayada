"use client";

import { Suspense, useState } from "react";
import { authService } from "@/services/auth";

function SetPasswordPageInner() {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleContinue = () => {
    setIsSubmitting(true);
    authService.startHostedLogin();
  };

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
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Affiliate Sign In</h1>
          <p className="text-[13px] text-gray-500 mt-1">Affiliate access now uses WorkOS AuthKit</p>
        </div>

        <div className="space-y-5">
          <p className="text-sm text-gray-600">
            Password setup links have been retired for affiliate accounts. Continue to sign in or
            complete account setup through AuthKit.
          </p>
          <button
            type="button"
            onClick={handleContinue}
            disabled={isSubmitting}
            className="w-full px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? "Redirecting..." : "Continue with WorkOS"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <SetPasswordPageInner />
    </Suspense>
  );
}
