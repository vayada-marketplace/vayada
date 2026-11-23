import type {
  HostNotification,
  HostNotificationFeed,
  HostNotificationSyncAlert,
} from "@/services/api/bookingNotificationsClient";

/** At most this many toasts show at once (desktop); phones show the newest only. */
export const MAX_TOASTS = 3;
/** Toasts close by themselves after this long, except a sync error, which stays until closed. */
export const TOAST_MS = 8_000;

export type Toast =
  | { key: string; type: "item"; item: HostNotification }
  | { key: string; type: "sync"; alert: HostNotificationSyncAlert };

/** The unread notifications that get a toast (VAY-2349): a new booking, a missed payment, a sync error. */
export function toastCandidates(feed: HostNotificationFeed): Toast[] {
  const toasts: Toast[] = feed.items
    .filter(
      (item) => !item.read && (item.kind === "booking_new" || item.kind === "payment_not_received"),
    )
    .map((item) => ({ key: item.key, type: "item", item }));
  if (feed.syncAlert && !feed.syncAlert.read)
    toasts.unshift({ key: feed.syncAlert.key, type: "sync", alert: feed.syncAlert });
  return toasts;
}

/** Every item and sync card the feed shows, read or not. */
function feedKeys(feed: HostNotificationFeed): string[] {
  const keys = feed.items.map((item) => item.key);
  if (feed.syncAlert) keys.push(feed.syncAlert.key);
  return keys;
}

/** Folds a new read into the shown toasts. The first read for a property only notes what is there: toasts
 * are for what arrives while Booking Admin is open. Read or vanished items lose their toast; new ones are
 * added oldest first, so the newest is at the bottom. Everything seen once, read or not, never toasts again:
 * marking a seen item unread (VAY-2591) is not something arriving. */
export function nextToasts(
  shown: Toast[],
  seen: Set<string> | null,
  feed: HostNotificationFeed,
): { toasts: Toast[]; seen: Set<string> } {
  const candidates = toastCandidates(feed);
  if (!seen) return { toasts: [], seen: new Set(feedKeys(feed)) };
  const live = new Set(candidates.map((toast) => toast.key));
  const fresh = candidates.filter((toast) => !seen.has(toast.key)).reverse();
  return {
    toasts: [...shown.filter((toast) => live.has(toast.key)), ...fresh].slice(-MAX_TOASTS),
    seen: new Set([...Array.from(seen), ...feedKeys(feed)]),
  };
}
