"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { HostNotificationSyncAlert } from "@vayada/product-onboarding/hostNotifications";
import type { NotificationActions } from "@vayada/product-onboarding/NotificationsBell";
import type { NotificationAction } from "@vayada/product-onboarding/notificationRows";
import type { useHostNotifications } from "@vayada/product-onboarding/useHostNotifications";
import { useSyncRetry } from "@vayada/product-onboarding/useSyncRetry";
import { openBookingAdmin } from "@/lib/utils/bookingAdminLink";
import { holdsPrices } from "@/lib/utils/holdsPrices";
import { pmsNotificationsClient } from "@/services/api/pmsNotificationsClient";

/** What the bell's rows do in PMS (VAY-2591). View booking and the channel manager open here (a room page
 * with unsaved prices is left with a full page load, so its warning runs); promo codes live in Booking Admin
 * and open there through the sign-in handoff on the selected property, as does Reservations for people PMS
 * won't show the booking to. */
export function usePmsNotificationActions(
  hotelId: string | undefined,
  notifications: Pick<ReturnType<typeof useHostNotifications>, "feed" | "markRead" | "reload">,
): NotificationActions {
  const router = useRouter();
  const { markRead, reload } = notifications;
  const canOpenPmsBookings = notifications.feed?.canOpenPmsBookings === true;
  const { sync, retrySync, resetSync } = useSyncRetry(hotelId, pmsNotificationsClient, reload);

  const go = useCallback(
    (href: string) => {
      if (holdsPrices()) window.location.assign(href);
      else router.push(href);
    },
    [router],
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
        go(`/bookings/${encodeURIComponent(action.bookingId)}`);
        return;
      }
      const targetPath =
        action.kind === "view_booking"
          ? `/reservations?search=${encodeURIComponent(action.reference)}`
          : `/promo-codes?edit=${encodeURIComponent(action.promoId)}`;
      void (async () => {
        // A full page change follows: let the mark go out first.
        if (!read) await markRead([key]);
        await openBookingAdmin(targetPath, hotelId);
      })();
    },
    [canOpenPmsBookings, go, hotelId, markRead],
  );

  const openChannelManager = useCallback(
    async (alert: HostNotificationSyncAlert) => {
      if (!alert.read) void markRead([alert.key]);
      go("/channel-manager");
    },
    [go, markRead],
  );

  return { act, retrySync, openChannelManager, sync, resetSync };
}
