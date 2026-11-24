import { createBrowserAuthHandoff } from "@vayada/product-onboarding";
import { readSelectedSharedPropertyId } from "@/lib/utils/sharedSetupGuard";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";

/**
 * Opens the booking in PMS, signed in on this property, in a new tab. The tab opens at the click,
 * so no popup blocker stops it; it goes to Reservations here when the sign-in exchange fails.
 */
export async function openInPms(booking: { id: string }, fallback: string): Promise<void> {
  const tab = window.open("", "_blank");
  let url: string | null = null;
  const csrfToken = getAuthCsrfToken();
  // The canonical property, as the header's bell uses for PMS.
  const propertyId = readSelectedSharedPropertyId() ?? getSelectedBookingHotelId();
  if (csrfToken && propertyId) {
    try {
      url = await createBrowserAuthHandoff({
        csrfToken,
        routingHints: { propertyId },
        sourceSurface: "booking-admin",
        targetPath: `/bookings/${encodeURIComponent(booking.id)}`,
        targetSurface: "pms-web",
      });
    } catch {
      url = null;
    }
  }
  const target = url ?? fallback;
  if (tab) {
    tab.opener = null;
    tab.location.href = target;
  } else {
    window.location.href = target;
  }
}
