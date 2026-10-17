import { Suspense } from "react";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

// Booking Admin hosts the hotel setup wizard (VAY-2261); it used to redirect to marketplace-web.
// Server-only switches such as AIRBNB_IMPORT_CALLBACK_ENABLED are read per request.
export const dynamic = "force-dynamic";

export default function SetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <SharedHotelSetupPage
        defaultEntryProduct="booking"
        airbnbImportEnabled={process.env.AIRBNB_IMPORT_CALLBACK_ENABLED === "true"}
      />
    </Suspense>
  );
}

function SetupLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-gray-50 px-6"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-medium text-gray-600">Loading your setup…</p>
    </div>
  );
}
