"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { MARKETING_BASE_URL } from "@/lib/constants/routes";
import { authService } from "@/services/auth";

// VAY-2260: the creator Marketplace is closed. Creators land here after login and from the
// old public teaser pages. Hotels keep their own apps; the link below takes them there.
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export default function MarketplaceClosedPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authService
      .ensureSession()
      .then((authenticated) => {
        if (!cancelled) setLoggedIn(authenticated);
      })
      .catch(() => {
        if (!cancelled) setLoggedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-[#fbfbfa] text-gray-950">
      <header className="flex items-center justify-center px-5 py-4 sm:py-6">
        <Image
          src="/vayada-logo.png"
          alt="vayada"
          width={120}
          height={107}
          className="h-8 w-auto"
          priority
        />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-5 pb-16 sm:pb-24">
        <div className="flex w-full max-w-3xl flex-col items-center gap-8 text-center sm:gap-10">
          <div className="flex flex-col items-center gap-4 sm:gap-5">
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-primary-500">
              vayada Marketplace
            </p>
            <h1 className="text-[32px] font-semibold leading-[38px] tracking-tight sm:text-[44px] sm:leading-[52px]">
              The creator Marketplace has closed.
            </h1>
            <p className="max-w-xl text-base leading-6 text-gray-600 sm:text-lg sm:leading-7">
              vayada now focuses on its hotel products, the Booking Engine and the PMS. Creator
              profiles, collaborations and earnings are no longer available, and your account data
              will be deleted.
            </p>
          </div>

          <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
            <a
              href={MARKETING_BASE_URL}
              className="inline-flex h-12 items-center justify-center rounded-full bg-primary-500 px-7 text-base font-medium text-white transition-colors hover:bg-primary-600"
            >
              Go to vayada.com
            </a>
            {loggedIn && (
              <button
                type="button"
                disabled={loggingOut}
                onClick={() => {
                  setLoggingOut(true);
                  void authService.logout();
                }}
                className="inline-flex h-12 items-center justify-center rounded-full border border-gray-300 bg-white px-7 text-base font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-60"
              >
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            )}
          </div>

          <p className="text-sm text-gray-500">
            Run a hotel?{" "}
            <a
              href={`${BOOKING_ADMIN_URL}/login`}
              className="font-medium text-primary-600 underline hover:text-primary-700"
            >
              Sign in to Booking Admin
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
