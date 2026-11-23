"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import type { NotificationActions } from "@vayada/product-onboarding/NotificationsBell";
import type { NotificationAction } from "@vayada/product-onboarding/notificationRows";
import type { useHostNotifications } from "@vayada/product-onboarding/useHostNotifications";
import { useSyncRetry } from "@vayada/product-onboarding/useSyncRetry";
import { openNotificationLink } from "@/lib/notificationLinks";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  bookingNotificationsClient,
  type HostNotificationSyncAlert,
} from "@/services/api/bookingNotificationsClient";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

type Client = Parameters<typeof useSyncRetry>[1];

/** What the bell's rows do in Booking Admin (VAY-2349), in one place: links mark the notification read
 * first, Retry sync reruns PMS → Channel manager's own sync and follows it to the end. View booking opens the
 * booking in PMS for people who may open it there (VAY-2480), else Reservations here. */
export function useNotificationActions(
  hotelId: string | undefined,
  notifications: Pick<ReturnType<typeof useHostNotifications>, "feed" | "markRead" | "reload">,
  client: Client = bookingNotificationsClient,
): NotificationActions {
  const router = useRouter();
  const { markRead, reload } = notifications;
  const canOpenPmsBookings = notifications.feed?.canOpenPmsBookings === true;
  const { sync, retrySync, resetSync } = useSyncRetry(hotelId, client, reload);

  /** The one-time exchange that opens a PMS page signed in, on the selected property; null when it can't be
   * made. */
  const pmsHandoff = useCallback(
    async (targetPath: string): Promise<string | null> => {
      const csrfToken = getAuthCsrfToken();
      if (!csrfToken || !hotelId) return null;
      try {
        return await createBrowserAuthHandoff({
          csrfToken,
          routingHints: { propertyId: hotelId },
          sourceSurface: "booking-admin",
          targetPath,
          targetSurface: "pms-web",
        });
      } catch {
        return null;
      }
    },
    [hotelId],
  );

  const act = useCallback(
    (key: string, read: boolean, action: NotificationAction) => {
      const openReservations = (reference: string) =>
        openNotificationLink({ path: "/reservations", param: "search" }, reference, router.push);
      if (action.kind === "view_booking" && canOpenPmsBookings && action.bookingId) {
        const { bookingId, reference } = action;
        void (async () => {
          // A full page change follows: let the mark go out first.
          if (!read) await markRead([key]);
          const url = await pmsHandoff(`/bookings/${encodeURIComponent(bookingId)}`);
          // Without the exchange, PMS's sign-in wouldn't know the property: stay on Reservations here.
          if (url) window.location.href = url;
          else openReservations(reference);
        })();
        return;
      }
      if (!read) void markRead([key]);
      if (action.kind === "contact_guest") {
        window.location.href = `mailto:${action.email}`;
        return;
      }
      if (action.kind === "view_booking") openReservations(action.reference);
      else
        openNotificationLink({ path: "/promo-codes", param: "edit" }, action.promoId, router.push);
    },
    [canOpenPmsBookings, markRead, pmsHandoff, router],
  );

  const openChannelManager = useCallback(
    async (alert: HostNotificationSyncAlert) => {
      // A full page change follows: let the mark go out first.
      if (!alert.read) await markRead([alert.key]);
      const targetPath = "/channel-manager";
      const url = await pmsHandoff(targetPath);
      if (url) {
        window.location.href = url;
        return;
      }
      // Require PMS sign-in when the one-time exchange is unavailable.
      try {
        window.location.href = crossAppReauthenticationUrl(PMS_FRONTEND_URL, targetPath);
      } catch {
        // No PMS address configured here: stay on the page.
      }
    },
    [markRead, pmsHandoff],
  );

  return { act, retrySync, openChannelManager, sync, resetSync };
}
