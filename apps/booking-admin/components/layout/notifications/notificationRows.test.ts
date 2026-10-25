import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import {
  parseHostNotificationFeed,
  type HostNotification,
  type HostNotificationFeed,
} from "@/services/api/bookingNotificationsClient";
import {
  badgeLabel,
  groupNotifications,
  itemsForTab,
  notificationRow,
  relativeTime,
  syncAlertText,
} from "./notificationRows";
import { withRead } from "./useHostNotifications";

// VAY-2349: what the bell's rows say, with the English catalog.
const messages = en as Record<string, string>;
const t = (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    messages[key] ?? key,
  );
const now = new Date("2026-10-25T12:00:00Z");
// Intl puts thin spaces around a range's dash; the assertions use plain ones.
const plain = <T extends { detail: string; meta: string }>(row: T) => ({
  ...row,
  detail: row.detail.replace(/[\u2009\u202f]/g, " "),
  meta: row.meta.replace(/[\u2009\u202f]/g, " "),
});
const context = { t, locale: "en", timeZone: "Europe/Berlin", now };

const booking = {
  id: "b0000000-0000-4000-8000-000000000001",
  reference: "VAY-ABC123",
  guestName: "Sarah Miller",
  guestEmail: null,
  roomName: "Deluxe Garden Room",
  roomCount: 1,
  checkIn: "2027-02-13",
  checkOut: "2027-02-18",
  adults: 2,
  children: 0,
  totalAmount: "600.00",
  currency: "EUR",
  paymentStatus: "unpaid",
  awaiting: null,
  cancelledBy: null,
  cancelReason: null,
  change: null,
} satisfies HostNotification["booking"];

function item(overrides: Partial<HostNotification>): HostNotification {
  return {
    key: "booking-event:e0000001-0000-4000-8000-000000000000",
    kind: "booking_new",
    category: "bookings",
    occurredAt: "2026-10-25T11:48:00Z",
    read: false,
    booking,
    ...overrides,
  };
}

function feed(overrides: Partial<HostNotificationFeed> = {}): HostNotificationFeed {
  return {
    generatedAt: "2026-10-25T12:00:00Z",
    timeZone: "Europe/Berlin",
    items: [],
    syncAlert: null,
    unread: { all: 0, bookings: 0, needsAction: 0, updates: 0 },
    badge: "none",
    ...overrides,
  };
}

describe("notification rows (VAY-2349)", () => {
  it("describes a new booking like the design", () => {
    expect(plain(notificationRow(item({}), context))).toEqual({
      key: "booking-event:e0000001-0000-4000-8000-000000000000",
      read: false,
      tone: "new",
      title: "New booking",
      amount: "€600",
      amountTone: "green",
      detail: "Sarah Miller · Deluxe Garden Room",
      meta: "Feb 13 – 18 · 5 nights · 2 adults · 12 min ago",
      action: { kind: "view_booking", reference: "VAY-ABC123" },
    });
  });

  it("describes changes, cancellations and missed payments", () => {
    expect(
      plain(
        notificationRow(
          item({
            kind: "booking_modified",
            occurredAt: "2026-10-25T07:00:00Z",
            booking: {
              ...booking,
              checkIn: "2027-02-20",
              checkOut: "2027-02-23",
              change: { kind: "dates", previousTotal: "240.00", newTotal: "360.00" },
            },
          }),
          context,
        ),
      ),
    ).toMatchObject({
      title: "Booking modified",
      amount: null,
      detail: "Sarah Miller · dates changed to Feb 20 – 23",
      meta: "Deluxe Garden Room · now €360 · 5 h ago",
    });
    expect(
      plain(
        notificationRow(
          item({
            kind: "booking_cancelled",
            occurredAt: "2026-10-24T16:40:00Z",
            booking: { ...booking, cancelledBy: "guest" },
          }),
          context,
        ),
      ),
    ).toMatchObject({
      title: "Booking cancelled",
      amount: "€600",
      amountTone: "grey",
      detail: "Sarah Miller · Deluxe Garden Room · cancelled by the guest",
      meta: "Feb 13 – 18 · no payment taken · yesterday 6:40 PM",
      action: null,
    });
    const missed = item({ kind: "payment_not_received", category: "needs_action" });
    expect(notificationRow(missed, context)).toMatchObject({
      title: "Payment not received",
      amountTone: "red",
      detail: "Sarah Miller · Deluxe Garden Room · bank transfer missed the deadline",
      // Without the guest's email (hidden until accepted), the row offers the booking instead.
      action: { kind: "view_booking", reference: "VAY-ABC123" },
    });
    expect(
      notificationRow(
        { ...missed, booking: { ...booking, guestEmail: "sarah@example.com" } },
        context,
      ).action,
    ).toEqual({ kind: "contact_guest", email: "sarah@example.com" });
  });

  it("describes promo codes and new team members", () => {
    const promo = { id: "p1", code: "SUMMER25", validUntil: "2026-10-31", uses: 14, maxUses: 100 };
    expect(
      notificationRow(
        item({ kind: "promo_ending", category: "needs_action", booking: undefined, promo }),
        context,
      ),
    ).toMatchObject({
      title: "Promo code expires soon",
      detail: "SUMMER25 · used 14 times · ends Oct 31",
      action: { kind: "edit_promo", promoId: "p1", label: "extend" },
    });
    expect(
      notificationRow(
        item({
          kind: "promo_limit_reached",
          category: "needs_action",
          booking: undefined,
          promo: { ...promo, code: "WELCOME10", uses: 50, maxUses: 50 },
        }),
        context,
      ),
    ).toMatchObject({ detail: "WELCOME10 · 50 / 50 uses", action: { label: "raiseLimit" } });
    expect(
      notificationRow(
        item({
          kind: "team_member_joined",
          category: "updates",
          booking: undefined,
          member: { name: "Anna Keller", role: "front_desk" },
        }),
        context,
      ).detail,
    ).toBe("Anna Keller joined as Front desk");
    expect(
      notificationRow(
        item({
          kind: "team_member_joined",
          category: "updates",
          booking: undefined,
          member: { name: null, role: "Reservations" },
        }),
        context,
      ).detail,
    ).toBe("A team member joined as Reservations");
  });

  it("groups by the property's calendar and says when", () => {
    const items = [
      item({ key: "a", occurredAt: "2026-10-25T09:00:00Z" }),
      item({ key: "b", occurredAt: "2026-10-24T21:30:00Z" }), // 23:30 in Berlin: yesterday
      item({ key: "c", occurredAt: "2026-10-21T10:00:00Z" }),
      item({ key: "d", occurredAt: "2026-10-01T10:00:00Z" }),
    ];
    expect(
      groupNotifications(items, "Europe/Berlin", now).map(({ group, items: grouped }) => [
        group,
        grouped.map((entry) => entry.key),
      ]),
    ).toEqual([
      ["today", ["a"]],
      ["yesterday", ["b"]],
      ["thisWeek", ["c"]],
      ["earlier", ["d"]],
    ]);
    expect(relativeTime("2026-10-25T11:59:40Z", "Europe/Berlin", now, t, "en")).toBe("just now");
    expect(relativeTime("2026-10-21T10:00:00Z", "Europe/Berlin", now, t, "en")).toBe(
      "Wed 12:00 PM",
    );
    expect(relativeTime("2026-10-01T10:00:00Z", "Europe/Berlin", now, t, "en")).toBe("Oct 1");
  });

  it("filters tabs, shows 9+ and words the sync card", () => {
    const missed = item({ key: "m", kind: "payment_not_received", category: "needs_action" });
    expect(itemsForTab([item({}), missed], "needs_action")).toEqual([missed]);
    expect([badgeLabel(3), badgeLabel(9), badgeLabel(12)]).toEqual(["3", "9", "9+"]);
    const alert = {
      key: "channel-sync:c:ari.1",
      read: false,
      domains: ["ari" as const],
      failedAt: "2026-10-25T11:50:00Z",
      // Berlin is back on UTC+1 from 25 October 2026.
      lastSuccessAt: "2026-10-25T11:20:00Z",
      canRetry: true,
    };
    expect(syncAlertText(alert, context)).toBe(
      "Availability hasn't updated since 12:20 PM. Guests may book rooms that are already taken on other channels.",
    );
    expect(syncAlertText({ ...alert, lastSuccessAt: null }, context)).toMatch(
      /^Availability hasn't reached/,
    );
  });

  it("applies read marks to the rows, the counts and the badge", () => {
    const missed = item({ key: "m", kind: "payment_not_received", category: "needs_action" });
    const current = feed({
      items: [item({}), missed],
      syncAlert: null,
      unread: { all: 3, bookings: 2, needsAction: 1, updates: 0 },
      badge: "red",
    });
    const one = withRead(current, new Set(["m"]));
    expect(one.unread).toEqual({ all: 2, bookings: 2, needsAction: 0, updates: 0 });
    expect(one.badge).toBe("blue");
    // A missed payment beyond the 50 rows made it red: red until the next read.
    const hidden = withRead(feed({ ...current, items: [item({})] }), new Set([item({}).key]));
    expect(hidden.badge).toBe("red");
    const all = withRead(current, "all");
    expect(all.unread).toEqual({ all: 0, bookings: 0, needsAction: 0, updates: 0 });
    expect(all.items.every((entry) => entry.read)).toBe(true);
    expect(all.badge).toBe("none");
  });

  it("parses the API's feed and skips kinds it doesn't know", () => {
    const parsed = parseHostNotificationFeed({
      ...feed({ items: [item({})], unread: { all: 1, bookings: 1, needsAction: 0, updates: 0 } }),
      items: [item({}), { ...item({}), kind: "new_feature" }],
    });
    expect(parsed?.items).toHaveLength(1);
    expect(parseHostNotificationFeed({ items: [] })).toBeNull();
  });
});
