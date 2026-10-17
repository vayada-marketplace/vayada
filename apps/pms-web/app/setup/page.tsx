"use client";

import { Suspense, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  buildSharedHotelSetupRedirectPath,
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
} from "@vayada/product-onboarding";

// Booking Admin hosts the shared hotel setup wizard (VAY-2261).
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export default function PmsSetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <CanonicalSetupRedirect />
    </Suspense>
  );
}

function CanonicalSetupRedirect() {
  const searchParams = useSearchParams();
  const redirectUrl = useMemo(
    () =>
      buildSharedHotelSetupRedirectPath({
        entryProduct: parseSharedHotelSetupEntryProduct(searchParams.get("entryProduct")) ?? "pms",
        returnProduct: "pms",
        returnTo: safeSharedHotelSetupReturnTo(searchParams.get("returnTo"), "/dashboard"),
        propertyId: searchParams.get("propertyId"),
        setupBaseUrl: BOOKING_ADMIN_URL,
        mode: searchParams.get("mode") === "add" ? "add" : undefined,
      }),
    [searchParams],
  );

  useEffect(() => {
    window.location.replace(redirectUrl);
  }, [redirectUrl]);

  return <SetupLoading />;
}

function SetupLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
    </div>
  );
}
