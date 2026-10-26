"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bookingNotificationsClient,
  isNotificationPropertyId,
  type HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";

/** How often the bell reads the feed while the tab is visible (VAY-2349 D3). */
export const NOTIFICATIONS_POLL_MS = 60_000;
/** A focus and a visibility change on returning to the tab come together: one read is enough. */
const READ_SPACING_MS = 2_000;

type Client = Pick<typeof bookingNotificationsClient, "load" | "markRead" | "markAllRead">;

/** loading until the first read; unavailable when there is no property or the person may not read its
 * notifications (the bell then hides); failed when a read went wrong (the next one tries again). */
export type NotificationsStatus = "loading" | "ready" | "failed" | "unavailable";

/** Marks sent but not yet confirmed by a later read: per key, and "all" while a Mark all read runs. */
type Pending = { hotelId: string; keys: Map<string, number>; all: number };

/** Red: the channel sync is failing, read or not (it stays red until it is fixed), or a missed payment is
 * unread. */
function hasUrgent(feed: HostNotificationFeed): boolean {
  return (
    feed.syncAlert !== null ||
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
  const badge = hasUrgent(next) ? "red" : unread.all === 0 ? "none" : hiddenUrgent ? "red" : "blue";
  return { ...next, badge };
}

function pendingMarks(pending: Pending | null, hotelId: string): Set<string> | "all" | null {
  if (!pending || pending.hotelId !== hotelId) return null;
  if (pending.all > 0) return "all";
  return pending.keys.size > 0 ? new Set(Array.from(pending.keys.keys())) : null;
}

/** The selected property's notifications: read now, every 60 s while the tab is visible, on page change
 * and when the window regains focus. A refused read (no access) isn't repeated for that property. */
export function useHostNotifications(
  hotelId: string | undefined,
  client: Client = bookingNotificationsClient,
) {
  const pathname = usePathname();
  const [feed, setFeed] = useState<HostNotificationFeed | null>(null);
  const [status, setStatus] = useState<NotificationsStatus>("loading");
  const refused = useRef<string | null>(null);
  const request = useRef(0);
  const lastRead = useRef(0);
  const pending = useRef<Pending | null>(null);
  const propertyId = isNotificationPropertyId(hotelId) ? hotelId : null;

  const load = useCallback(
    async (force = false) => {
      if (!propertyId || refused.current === propertyId) return;
      if (document.visibilityState === "hidden") return;
      if (!force && Date.now() - lastRead.current < READ_SPACING_MS) return;
      lastRead.current = Date.now();
      const id = ++request.current;
      try {
        const next = await client.load(propertyId);
        if (id !== request.current) return;
        // Marks still on their way to the server stay applied.
        const marks = pendingMarks(pending.current, propertyId);
        setFeed(marks ? withRead(next, marks) : next);
        setStatus("ready");
      } catch (error) {
        if (id !== request.current) return;
        const code = (error as { status?: number } | null)?.status;
        if (code === 401 || code === 403) {
          refused.current = propertyId;
          setFeed(null);
          setStatus("unavailable");
        } else setStatus((current) => (current === "ready" ? current : "failed"));
      }
    },
    [client, propertyId],
  );

  useEffect(() => {
    setFeed(null);
    setStatus(propertyId && refused.current !== propertyId ? "loading" : "unavailable");
    pending.current = null;
  }, [propertyId]);

  useEffect(() => {
    void load(true);
  }, [load, pathname]);

  useEffect(() => {
    const refresh = () => void load();
    const timer = window.setInterval(() => void load(true), NOTIFICATIONS_POLL_MS);
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

  /** Runs a mark: shown at once, and kept over reads that started before it was saved. */
  const mark = useCallback(
    async (keys: string[] | "all", send: (propertyId: string) => Promise<void>) => {
      if (!propertyId) return;
      if (pending.current?.hotelId !== propertyId)
        pending.current = { hotelId: propertyId, keys: new Map(), all: 0 };
      const marks = pending.current;
      if (keys === "all") marks.all += 1;
      else for (const key of keys) marks.keys.set(key, (marks.keys.get(key) ?? 0) + 1);
      setFeed((current) =>
        current ? withRead(current, keys === "all" ? "all" : new Set(keys)) : current,
      );
      try {
        await send(propertyId);
      } catch {
        // The next read shows the server's state again.
      } finally {
        if (keys === "all") marks.all -= 1;
        else
          for (const key of keys) {
            const left = (marks.keys.get(key) ?? 1) - 1;
            if (left > 0) marks.keys.set(key, left);
            else marks.keys.delete(key);
          }
        // A read already on its way may have started before the mark was saved: drop it. The next
        // read starts after, so it has the mark.
        request.current += 1;
      }
    },
    [propertyId],
  );

  const markRead = useCallback(
    async (keys: string[]) => {
      if (keys.length === 0) return;
      await mark(keys, (id) => client.markRead(id, keys));
    },
    [client, mark],
  );

  const markAllRead = useCallback(
    async (seen: HostNotificationFeed) => {
      await mark("all", (id) =>
        client.markAllRead(id, {
          before: seen.generatedAt,
          syncAlertKey: seen.syncAlert?.key ?? null,
        }),
      );
    },
    [client, mark],
  );

  return { feed, status, reload: load, markRead, markAllRead };
}
