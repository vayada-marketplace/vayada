import { crossAppReauthenticationUrl } from "@vayada/product-onboarding";

/** Booking Admin's Airbnb import for the property, through its sign-in, or null while the import is off or the
 * configuration is unusable. Rooms & Rates offers it in its ☰ menu (VAY-2338). */
export function airbnbImportHref(propertyId: string): string | null {
  if (
    process.env.NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED !== "true" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(propertyId)
  )
    return null;
  try {
    // Booking Admin hosts the Airbnb connect page with the setup wizard (VAY-2261).
    const base = new URL(process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "");
    if (base.protocol !== "https:" || base.username || base.password) return null;
    return crossAppReauthenticationUrl(base.origin, `/setup/airbnb-connect/${propertyId}`);
  } catch {
    return null;
  }
}
