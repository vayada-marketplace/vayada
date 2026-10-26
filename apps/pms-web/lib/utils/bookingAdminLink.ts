import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import { BOOKING_ADMIN_URL } from "./setupHandoff";

/**
 * Opens a Booking Admin page signed in, the way the sidebar switches apps: a one-time session
 * handoff when the exchange is up, Booking Admin's own login with the path otherwise.
 */
export async function openBookingAdmin(targetPath: string): Promise<void> {
  const csrfToken = getAuthCsrfToken();
  if (csrfToken) {
    try {
      window.location.href = await createBrowserAuthHandoff({
        csrfToken,
        sourceSurface: "pms-web",
        targetPath,
        targetSurface: "booking-admin",
      });
      return;
    } catch {
      // Booking Admin's login keeps the path when the one-time exchange is unavailable.
    }
  }
  window.location.href = crossAppReauthenticationUrl(BOOKING_ADMIN_URL, targetPath);
}
