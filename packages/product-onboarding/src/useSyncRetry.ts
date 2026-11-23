"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostNotificationSyncAlert, HostNotificationsClient } from "./hostNotifications";

/** "Retry sync" follows its operation this often, for at most this long. */
const SYNC_POLL_MS = 5_000;
const SYNC_WAIT_MS = 3 * 60_000;

/** idle; running while the retried sync works; succeeded once it did (the card turns into the green line
 * until the panel closes); failed when it failed or couldn't start; slow when it is still running after
 * 3 minutes. */
export type SyncRetryState = "idle" | "running" | "succeeded" | "failed" | "slow";

/** The bell's "Retry sync" (VAY-2349), shared by Booking Admin and PMS (VAY-2591): reruns PMS → Channel
 * manager's own sync and follows it to the end. A retry belongs to its property and its page: leaving either
 * stops following it. */
export function useSyncRetry(
  hotelId: string | undefined,
  client: Pick<HostNotificationsClient, "retrySync" | "syncOperationStatus">,
  reload: (force?: boolean) => Promise<void> | void,
) {
  const [sync, setSync] = useState<SyncRetryState>("idle");
  const run = useRef(0);

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

  const resetSync = useCallback(() => {
    setSync((current) => (current === "running" ? current : "idle"));
  }, []);

  return { sync, retrySync, resetSync };
}
