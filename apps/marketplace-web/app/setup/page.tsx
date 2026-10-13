import { Suspense } from "react";
import { ROUTES } from "@/lib/constants";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";

// Server-only switches such as AIRBNB_IMPORT_CALLBACK_ENABLED are read per request.
export const dynamic = "force-dynamic";

export default function MarketplaceSetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <SharedHotelSetupPage
        defaultEntryProduct="marketplace"
        defaultReturnTo={ROUTES.MARKETPLACE}
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
