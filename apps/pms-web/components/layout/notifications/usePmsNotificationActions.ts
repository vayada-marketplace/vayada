"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import type { HostNotificationSyncAlert } from "@vayada/product-onboarding/hostNotifications";
import type { NotificationActions } from "@vayada/product-onboarding/NotificationsBell";
import type { NotificationAction } from "@vayada/product-onboarding/notificationRows";
import type { useHostNotifications } from "@vayada/product-onboarding/useHostNotifications";
import { useSyncRetry } from "@vayada/product-onboarding/useSyncRetry";
import { pmsNotificationsClient } from "@/services/api/pmsNotificationsClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";

const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

/** What the bell's rows do in PMS (VAY-2591). View booking and the channel manager open here; promo codes
 * live in Booking Admin and open there through the sign-in handoff, on the selected property, as does
 * Reservations for people PMS won't show the booking to. */
export function usePmsNotificationActions(
  hotelId: string | undefined,
  notifications: Pick<ReturnType<typeof useHostNotifications>, "feed" | "markRead" | "reload">,
): NotificationActions {
  const router = useRouter();
  const { markRead, reload } = notifications;
  const canOpenPmsBookings = notifications.feed?.canOpenPmsBookings === true;
  const { sync, retrySync, resetSync } = useSyncRetry(hotelId, pmsNotificationsClient, reload);

  const openBookingAdmin = useCallback(
    async (targetPath: string) => {
      const csrfToken = getAuthCsrfToken();
      if (csrfToken && hotelId) {
        try {
          window.location.href = await createBrowserAuthHandoff({
            csrfToken,
            routingHints: { propertyId: hotelId },
            sourceSurface: "pms-web",
            targetPath,
            targetSurface: "booking-admin",
          });
          return;
        } catch {
          // Require Booking Admin sign-in when the one-time exchange is unavailable.
        }
      }
      try {
        window.location.href = crossAppReauthenticationUrl(BOOKING_ADMIN_URL, targetPath);
      } catch {
        // No Booking Admin address configured here: stay on the page.
      }
    },
    [hotelId],
  );

  const act = useCallback(
    (key: string, read: boolean, action: NotificationAction) => {
      if (action.kind === "contact_guest") {
        if (!read) void markRead([key]);
        window.location.href = `mailto:${action.email}`;
        return;
      }
      if (action.kind === "view_booking" && canOpenPmsBookings && action.bookingId) {
        if (!read) void markRead([key]);
        router.push(`/bookings/${encodeURIComponent(action.bookingId)}`);
        return;
      }
      const targetPath =
        action.kind === "view_booking"
          ? `/reservations?search=${encodeURIComponent(action.reference)}`
          : `/promo-codes?edit=${encodeURIComponent(action.promoId)}`;
      void (async () => {
        // A full page change follows: let the mark go out first.
        if (!read) await markRead([key]);
        await openBookingAdmin(targetPath);
      })();
    },
    [canOpenPmsBookings, markRead, openBookingAdmin, router],
  );

  const openChannelManager = useCallback(
    async (alert: HostNotificationSyncAlert) => {
      if (!alert.read) void markRead([alert.key]);
      router.push("/channel-manager");
    },
    [markRead, router],
  );

  return { act, retrySync, openChannelManager, sync, resetSync };
}
