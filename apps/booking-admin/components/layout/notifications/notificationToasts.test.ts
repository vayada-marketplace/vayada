import { describe, expect, it } from "vitest";
import type {
  HostNotification,
  HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";
import { MAX_TOASTS, nextToasts, toastCandidates } from "./notificationToasts";

// VAY-2349 part 3: which notifications get a toast, and when.
function item(key: string, kind: HostNotification["kind"], read = false): HostNotification {
  return {
    key,
    kind,
    category: kind === "payment_not_received" ? "needs_action" : "bookings",
    occurredAt: "2026-10-25T11:00:00Z",
    read,
  };
}

function feed(items: HostNotification[], syncKey: string | null = null): HostNotificationFeed {
  return {
    generatedAt: "2026-10-25T12:00:00Z",
    timeZone: "Europe/Berlin",
    items,
    syncAlert: syncKey
      ? {
          key: syncKey,
          read: false,
          domains: ["ari"],
          failedAt: "2026-10-25T11:50:00Z",
          lastSuccessAt: null,
          canRetry: true,
          canViewDetails: true,
        }
      : null,
    unread: { all: 0, bookings: 0, needsAction: 0, updates: 0 },
    badge: "none",
  };
}

describe("notification toasts (VAY-2349)", () => {
  it("toasts only unread new bookings, missed payments and the sync error", () => {
    const candidates = toastCandidates(
      feed(
        [
          item("new", "booking_new"),
          item("paid", "payment_not_received"),
          item("old", "booking_new", true),
          item("moved", "booking_modified"),
          item("promo", "promo_ending"),
        ],
        "sync-1",
      ),
    );
    expect(candidates.map((toast) => toast.key)).toEqual(["sync-1", "new", "paid"]);
  });

  it("notes what is there on the first read and toasts what arrives later, newest last", () => {
    const first = nextToasts([], null, feed([item("before", "booking_new")]));
    expect(first.toasts).toEqual([]);

    // Feeds are newest first: "b" arrived after "a".
    const second = nextToasts(
      first.toasts,
      first.seen,
      feed([
        item("b", "booking_new"),
        item("a", "payment_not_received"),
        item("before", "booking_new"),
      ]),
    );
    expect(second.toasts.map((toast) => toast.key)).toEqual(["a", "b"]);

    // Read since (in the panel, or by the toast's own button): its toast goes; nothing toasts twice.
    const third = nextToasts(
      second.toasts,
      second.seen,
      feed([
        item("b", "booking_new", true),
        item("a", "payment_not_received"),
        item("before", "booking_new"),
      ]),
    );
    expect(third.toasts.map((toast) => toast.key)).toEqual(["a"]);
  });

  it("keeps at most three, dropping the oldest; a new sync error comes last", () => {
    const first = nextToasts([], null, feed([]));
    const many = feed(
      ["e", "d", "c", "b", "a"].map((key) => item(key, "booking_new")),
      "sync-1",
    );
    const next = nextToasts(first.toasts, first.seen, many);
    expect(next.toasts).toHaveLength(MAX_TOASTS);
    expect(next.toasts.map((toast) => toast.key)).toEqual(["d", "e", "sync-1"]);
  });
});
