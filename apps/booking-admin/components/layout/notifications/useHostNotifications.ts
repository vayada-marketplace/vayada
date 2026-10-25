"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bookingNotificationsClient,
  type HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";

/** How often the bell reads the feed while the tab is visible (VAY-2349 D3). */
export const NOTIFICATIONS_POLL_MS = 60_000;

type Client = Pick<typeof bookingNotificationsClient, "load" | "markRead" | "markAllRead">;
type Marks = { hotelId: string; keys: Set<string> | "all" } | null;

function hasUrgent(feed: HostNotificationFeed): boolean {
  return (
    (feed.syncAlert !== null && !feed.syncAlert.read) ||
    feed.items.some((item) => !item.read && item.kind === "payment_not_received")
  );
}

/** Applies marks made on this page before the next read confirms them: the rows, the unread counts (which
 * cover all 30 days, beyond the 50 rows) and the badge. */
export function withRead(
  feed: HostNotificationFeed,
  keys: ReadonlySet<string> | "all",
): HostNotificationFeed {
  const marked = (key: string) => keys === "all" || keys.has(key);
  const unread = { ...feed.unread };
  const take = (category: string) => {
    unread.all -= 1;
    if (category === "bookings") unread.bookings -= 1;
    else if (category === "needs_action") unread.needsAction -= 1;
    else unread.updates -= 1;
  };
  const items = feed.items.map((item) => {
    if (item.read || !marked(item.key)) return item;
    take(item.category);
    return { ...item, read: true };
  });
  let syncAlert = feed.syncAlert;
  if (syncAlert && !syncAlert.read && marked(syncAlert.key)) {
    take("needs_action");
    syncAlert = { ...syncAlert, read: true };
  }
  if (keys === "all") Object.assign(unread, { all: 0, bookings: 0, needsAction: 0, updates: 0 });
  for (const key of Object.keys(unread) as (keyof typeof unread)[])
    unread[key] = Math.max(0, unread[key]);
  const next = { ...feed, items, syncAlert, unread };
  // A red badge from an item beyond the 50 rows stays red until the next read.
  const hiddenUrgent = feed.badge === "red" && !hasUrgent(feed) && keys !== "all";
  const badge = unread.all === 0 ? "none" : hasUrgent(next) || hiddenUrgent ? "red" : "blue";
  return { ...next, badge };
}

function remember(marks: { current: Marks }, hotelId: string, keys: Set<string> | "all") {
  const current = marks.current?.hotelId === hotelId ? marks.current.keys : new Set<string>();
  marks.current = {
    hotelId,
    keys:
      keys === "all" || current === "all"
        ? "all"
        : new Set(Array.from(current).concat(Array.from(keys))),
  };
}

/** The selected property's notifications: read now, every 60 s while the tab is visible, on page change
 * and when the window regains focus. A refused read (no access) isn't repeated for that property. */
export function useHostNotifications(
  hotelId: string | undefined,
  client: Client = bookingNotificationsClient,
) {
  const pathname = usePathname();
  const [feed, setFeed] = useState<HostNotificationFeed | null>(null);
  const [failed, setFailed] = useState(false);
  const refused = useRef<string | null>(null);
  const request = useRef(0);
  const marks = useRef<Marks>(null);

  const load = useCallback(async () => {
    if (!hotelId || refused.current === hotelId) return;
    if (document.visibilityState === "hidden") return;
    const id = ++request.current;
    try {
      const next = await client.load(hotelId);
      if (id !== request.current) return;
      setFailed(false);
      // Marks still on their way to the server stay applied.
      const pending = marks.current?.hotelId === hotelId ? marks.current.keys : null;
      setFeed(pending ? withRead(next, pending) : next);
    } catch (error) {
      if (id !== request.current) return;
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403) {
        refused.current = hotelId;
        setFeed(null);
      } else setFailed(true);
    }
  }, [client, hotelId]);

  useEffect(() => {
    setFeed(null);
    setFailed(false);
    marks.current = null;
  }, [hotelId]);

  useEffect(() => {
    void load();
  }, [load, pathname]);

  useEffect(() => {
    const refresh = () => void load();
    const timer = window.setInterval(refresh, NOTIFICATIONS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const markRead = useCallback(
    async (keys: string[]) => {
      if (!hotelId || keys.length === 0) return;
      remember(marks, hotelId, new Set(keys));
      setFeed((current) => (current ? withRead(current, new Set(keys)) : current));
      try {
        await client.markRead(hotelId, keys);
      } catch {
        // The next read shows the server's state again.
      } finally {
        marks.current = null;
      }
    },
    [client, hotelId],
  );

  const markAllRead = useCallback(
    async (seen: HostNotificationFeed) => {
      if (!hotelId) return;
      remember(marks, hotelId, "all");
      setFeed((current) => (current ? withRead(current, "all") : current));
      try {
        await client.markAllRead(hotelId, {
          before: seen.generatedAt,
          syncAlertKey: seen.syncAlert?.key ?? null,
        });
      } catch {
        // The next read shows the server's state again.
      } finally {
        marks.current = null;
      }
    },
    [client, hotelId],
  );

  return { feed, failed, reload: load, markRead, markAllRead };
}
