"use client";
import { crossAppReauthenticationUrl } from "@vayada/product-onboarding";

export function AirbnbImportLink({ propertyId }: { propertyId: string }) {
  if (
    process.env.NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED !== "true" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(propertyId)
  )
    return null;
  let href: string;
  try {
    const base = new URL(process.env.NEXT_PUBLIC_MARKETPLACE_URL || "");
    if (base.protocol !== "https:" || base.username || base.password) return null;
    href = crossAppReauthenticationUrl(base.origin, `/setup/airbnb-connect/${propertyId}`);
  } catch {
    return null;
  }
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-semibold text-primary-700 underline"
      >
        Import rooms from Airbnb (opens in a new tab)
      </a>
      <p className="mt-1 text-sm text-gray-600">
        Connect your account, choose listings, and review the details before saving. Refresh this
        page after importing to see your rooms.
      </p>
    </div>
  );
}
