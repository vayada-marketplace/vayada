"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserAuthHandoff, crossAppReauthenticationUrl } from "@vayada/product-onboarding";
import { openNotificationLink } from "@/lib/notificationLinks";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  bookingNotificationsClient,
  type HostNotificationSyncAlert,
} from "@/services/api/bookingNotificationsClient";
import type { NotificationAction } from "./notificationRows";
import type { useHostNotifications } from "./useHostNotifications";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";
/** "Retry sync" follows its operation this often, for at most this long. */
const SYNC_POLL_MS = 5_000;
const SYNC_WAIT_MS = 3 * 60_000;

/** idle; running while the retried sync works; succeeded once it did (the card turns into the green line
 * until the panel closes); failed when it failed or couldn't start; slow when it is still running after
 * 3 minutes. */
export type SyncRetryState = "idle" | "running" | "succeeded" | "failed" | "slow";

type Client = Pick<typeof bookingNotificationsClient, "retrySync" | "syncOperationStatus">;

/** What the bell's rows do (VAY-2349), in one place: links mark the notification read first, Retry sync
 * reruns PMS → Channel manager's own sync and follows it to the end. */
export function useNotificationActions(
  hotelId: string | undefined,
  notifications: Pick<ReturnType<typeof useHostNotifications>, "markRead" | "reload">,
  client: Client = bookingNotificationsClient,
) {
  const router = useRouter();
  const { markRead, reload } = notifications;
  const [sync, setSync] = useState<SyncRetryState>("idle");
  const run = useRef(0);

  // A retry belongs to its property and its page: leaving either stops following it.
  useEffect(() => {
    run.current += 1;
    setSync("idle");
  }, [hotelId]);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const act = useCallback(
    (key: string, read: boolean, action: NotificationAction) => {
      if (!read) void markRead([key]);
      if (action.kind === "contact_guest") {
        window.location.href = `mailto:${action.email}`;
        return;
      }
      if (action.kind === "view_booking")
        openNotificationLink(
          { path: "/reservations", param: "search" },
          action.reference,
          router.push,
        );
      else
        openNotificationLink({ path: "/promo-codes", param: "edit" }, action.promoId, router.push);
    },
    [markRead, router],
  );

  const retrySync = useCallback(
    async (alert: HostNotificationSyncAlert) => {
      if (!hotelId) return;
      const id = ++run.current;
      setSync("running");
      try {
        const operations = await client.retrySync(hotelId, alert.domains);
        const deadline = Date.now() + SYNC_WAIT_MS;
        let open = operations;
        while (open.length > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, SYNC_POLL_MS));
          if (id !== run.current) return;
          const statuses = await Promise.all(
            open.map((operation) => client.syncOperationStatus(hotelId, operation)),
          );
          if (id !== run.current) return;
          if (statuses.includes("failed")) {
            setSync("failed");
            return;
          }
          open = open.filter((_, index) => statuses[index] === "running");
          if (open.length > 0 && Date.now() > deadline) {
            setSync("slow");
            return;
          }
        }
        setSync("succeeded");
        void reload(true);
      } catch {
        if (id === run.current) setSync("failed");
      }
    },
    [client, hotelId, reload],
  );

  const openChannelManager = useCallback(
    async (alert: HostNotificationSyncAlert) => {
      // A full page change follows: let the mark go out first.
      if (!alert.read) await markRead([alert.key]);
      const targetPath = "/channel-manager";
      const csrfToken = getAuthCsrfToken();
      if (csrfToken && hotelId) {
        try {
          window.location.href = await createBrowserAuthHandoff({
            csrfToken,
            routingHints: { propertyId: hotelId },
            sourceSurface: "booking-admin",
            targetPath,
            targetSurface: "pms-web",
          });
          return;
        } catch {
          // Require PMS sign-in when the one-time exchange is unavailable.
        }
      }
      try {
        window.location.href = crossAppReauthenticationUrl(PMS_FRONTEND_URL, targetPath);
      } catch {
        // No PMS address configured here: stay on the page.
      }
    },
    [hotelId, markRead],
  );

  const resetSync = useCallback(() => {
    setSync((current) => (current === "running" ? current : "idle"));
  }, []);

  return { act, retrySync, openChannelManager, sync, resetSync };
}
