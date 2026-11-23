"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isNotificationPropertyId,
  type HostNotificationFeed,
  type HostNotificationsClient,
} from "./hostNotifications";

/** How often the bell reads the feed while the tab is visible (VAY-2349 D3). */
export const NOTIFICATIONS_POLL_MS = 60_000;
/** A focus and a visibility change on returning to the tab come together: one read is enough. */
const READ_SPACING_MS = 2_000;

type Client = Pick<
  HostNotificationsClient,
  "load" | "markRead" | "markUnread" | "markDone" | "markAllRead"
>;

/** What a mark does to an item (VAY-2591): read, unread (on a done item: no longer done), or done (needs-action
 * items only; a done item is read). */
export type NotificationMark = "read" | "unread" | "done";
/** "Mark all read" as the person saw it: everything up to the feed's generatedAt (not what came since). */
type ReadAll = { readBefore: string };

/** loading until the first read; unavailable when there is no property or the person may not read its
 * notifications (the bell then hides); failed when a read went wrong (the next one tries again). */
export type NotificationsStatus = "loading" | "ready" | "failed" | "unavailable";

/** Marks sent but not yet confirmed by a later read: per key the latest mark and how many are on their way,
 * and how many "Mark all read" are running. */
type Pending = {
  hotelId: string;
  keys: Map<string, { mark: NotificationMark; count: number }>;
  all: number;
  /** The latest generatedAt a running "Mark all read" was made from. */
  allBefore: string;
};

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
export function withMarks(
  feed: HostNotificationFeed,
  marks: ReadonlyMap<string, NotificationMark> | ReadAll,
): HostNotificationFeed {
  const readAll = "readBefore" in marks ? Date.parse(marks.readBefore) : null;
  const markOf = (key: string, occurredAt?: string): NotificationMark | undefined =>
    readAll !== null
      ? occurredAt === undefined || Date.parse(occurredAt) <= readAll
        ? "read"
        : undefined
      : (marks as ReadonlyMap<string, NotificationMark>).get(key);
  const unread = { ...feed.unread };
  const count = (category: string, step: 1 | -1) => {
    unread.all += step;
    if (category === "bookings") unread.bookings += step;
    else if (category === "needs_action") unread.needsAction += step;
    else unread.updates += step;
  };
  const items = feed.items.map((item) => {
    const mark = markOf(item.key, item.occurredAt);
    if (mark === "read" || (mark === "done" && item.category !== "needs_action")) {
      if (item.read) return item;
      count(item.category, -1);
      return { ...item, read: true };
    }
    if (mark === "done") {
      if (item.done) return item;
      if (!item.read) count(item.category, -1);
      return { ...item, read: true, done: true };
    }
    if (mark === "unread") {
      if (!item.read) return item;
      count(item.category, 1);
      return { ...item, read: false, done: false };
    }
    return item;
  });
  let syncAlert = feed.syncAlert;
  const alertMark = syncAlert ? markOf(syncAlert.key) : undefined;
  if (syncAlert && !syncAlert.read && (alertMark === "read" || alertMark === "done")) {
    count("needs_action", -1);
    syncAlert = { ...syncAlert, read: true };
  } else if (syncAlert && syncAlert.read && alertMark === "unread") {
    count("needs_action", 1);
    syncAlert = { ...syncAlert, read: false };
  }
  // Mark all covers the 30 days beyond the rows too; what came since is listed first, so the rows decide.
  if (readAll !== null) {
    Object.assign(unread, { all: 0, bookings: 0, needsAction: 0, updates: 0 });
    for (const item of items) if (!item.read) count(item.category, 1);
    if (syncAlert && !syncAlert.read) count("needs_action", 1);
  }
  for (const key of Object.keys(unread) as (keyof typeof unread)[])
    unread[key] = Math.max(0, unread[key]);
  const next = { ...feed, items, syncAlert, unread };
  // A red badge from an item beyond the 50 rows stays red until the next read.
  const hiddenUrgent = feed.badge === "red" && !hasUrgent(feed) && readAll === null;
  const badge = hasUrgent(next) ? "red" : unread.all === 0 ? "none" : hiddenUrgent ? "red" : "blue";
  return { ...next, badge };
}

/** Applies the marks still on their way: a running "Mark all read" first, then each row's own mark. */
function withPendingMarks(
  feed: HostNotificationFeed,
  pending: Pending | null,
  hotelId: string,
): HostNotificationFeed {
  if (!pending || pending.hotelId !== hotelId) return feed;
  const all = pending.all > 0 ? withMarks(feed, { readBefore: pending.allBefore }) : feed;
  if (pending.keys.size === 0) return all;
  return withMarks(all, new Map(Array.from(pending.keys, ([key, { mark }]) => [key, mark])));
}

/** The selected property's notifications: read now, every 60 s while the tab is visible, on page change
 * and when the window regains focus. A refused read (no access) isn't repeated for that property. */
export function useHostNotifications(hotelId: string | undefined, client: Client) {
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
        setFeed(withPendingMarks(next, pending.current, propertyId));
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
    async (
      keys: string[] | ReadAll,
      kind: NotificationMark,
      send: (propertyId: string) => Promise<void>,
    ) => {
      if (!propertyId) return;
      if (pending.current?.hotelId !== propertyId)
        pending.current = { hotelId: propertyId, keys: new Map(), all: 0, allBefore: "" };
      const marks = pending.current;
      if (!Array.isArray(keys)) {
        marks.all += 1;
        if (keys.readBefore > marks.allBefore) marks.allBefore = keys.readBefore;
      } else
        for (const key of keys)
          marks.keys.set(key, { mark: kind, count: (marks.keys.get(key)?.count ?? 0) + 1 });
      setFeed((current) =>
        current
          ? withMarks(current, Array.isArray(keys) ? new Map(keys.map((key) => [key, kind])) : keys)
          : current,
      );
      try {
        await send(propertyId);
      } catch {
        // The next read shows the server's state again.
      } finally {
        if (!Array.isArray(keys)) marks.all -= 1;
        else
          for (const key of keys) {
            const entry = marks.keys.get(key);
            if (entry && entry.count > 1) marks.keys.set(key, { ...entry, count: entry.count - 1 });
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
      await mark(keys, "read", (id) => client.markRead(id, keys));
    },
    [client, mark],
  );

  const markUnread = useCallback(
    async (keys: string[]) => {
      if (keys.length === 0) return;
      await mark(keys, "unread", (id) => client.markUnread(id, keys));
    },
    [client, mark],
  );

  const markDone = useCallback(
    async (keys: string[]) => {
      if (keys.length === 0) return;
      await mark(keys, "done", (id) => client.markDone(id, keys));
    },
    [client, mark],
  );

  const markAllRead = useCallback(
    async (seen: HostNotificationFeed) => {
      await mark({ readBefore: seen.generatedAt }, "read", (id) =>
        client.markAllRead(id, {
          before: seen.generatedAt,
          syncAlertKey: seen.syncAlert?.key ?? null,
        }),
      );
    },
    [client, mark],
  );

  return { feed, status, reload: load, markRead, markUnread, markDone, markAllRead };
}
