import { describe, expect, it } from "vitest";

import {
  readAllKeys,
  buildHostNotificationFeed,
  isHostNotificationKey,
  type BookingEventRow,
  type HostNotificationSources,
  type HostNotificationViewer,
} from "./bookingHostNotifications.js";

// VAY-2349: the Booking Admin bell's feed, built from the source rows.
const viewer: HostNotificationViewer = {
  userId: "50000000-0000-4000-8000-000000000005",
  organizationId: "10000000-0000-4000-8000-000000000001",
  canReadPromos: true,
  canReadGuestContact: true,
  retrySyncDomains: ["ari", "booking"],
  canOpenChannelManager: true,
};

let eventNumber = 0;
function event(overrides: Partial<BookingEventRow> = {}): BookingEventRow {
  eventNumber += 1;
  return {
    eventId: `e${String(eventNumber).padStart(7, "0")}-0000-4000-8000-000000000000`,
    eventType: "guest_booking.created",
    lifecycleStatus: "confirmed",
    actorType: "guest",
    occurredAt: new Date("2026-10-25T09:00:00Z"),
    payload: {},
    bookingId: `b${String(eventNumber).padStart(7, "0")}-0000-4000-8000-000000000001`,
    reference: "VAY-ABC123",
    paymentStatus: "unpaid",
    cancellationReason: null,
    paymentMethod: "pay_at_property",
    hadHostDeadline: false,
    checkIn: "2027-02-13",
    checkOut: "2027-02-18",
    adults: 2,
    children: 0,
    roomCount: 1,
    totalAmount: "600.00",
    currency: "EUR",
    firstName: "Sarah",
    lastName: "Miller",
    email: "sarah@example.com",
    contactAccepted: false,
    roomName: "Deluxe Garden Room",
    ...overrides,
  };
}

function sources(overrides: Partial<HostNotificationSources> = {}): HostNotificationSources {
  return {
    timeZone: "Europe/Berlin",
    bookingEvents: [],
    syncStatuses: [],
    promos: [],
    members: [],
    readKeys: new Set(),
    guestContactAlways: false,
    ...overrides,
  };
}

describe("Booking Admin notifications feed (VAY-2349)", () => {
  it("lists new, modified and cancelled bookings under Bookings with the booking's details", () => {
    const created = event();
    const moved = event({
      eventType: "guest_booking.host_dates_updated",
      actorType: "property_user",
      occurredAt: new Date("2026-10-25T10:00:00Z"),
      payload: { oldTotal: "240.00", newTotal: "360.00" },
    });
    const withdrawn = event({
      eventType: "guest_booking.withdrawn",
      occurredAt: new Date("2026-10-24T18:40:00Z"),
    });
    const feed = buildHostNotificationFeed(
      sources({ bookingEvents: [created, moved, withdrawn] }),
      viewer,
    );

    expect(feed.items.map((item) => [item.kind, item.category])).toEqual([
      ["booking_modified", "bookings"],
      ["booking_new", "bookings"],
      ["booking_cancelled", "bookings"],
    ]);
    expect(feed.items[0]!.booking).toMatchObject({
      change: { kind: "dates", previousTotal: "240.00", newTotal: "360.00" },
    });
    expect(feed.items[1]).toMatchObject({
      key: `booking-event:${created.eventId}`,
      occurredAt: "2026-10-25T09:00:00.000Z",
      read: false,
      booking: {
        reference: "VAY-ABC123",
        guestName: "Sarah Miller",
        guestEmail: null,
        roomName: "Deluxe Garden Room",
        checkIn: "2027-02-13",
        checkOut: "2027-02-18",
        totalAmount: "600.00",
        currency: "EUR",
        awaiting: null,
      },
    });
    expect(feed.items[2]!.booking).toMatchObject({ cancelledBy: "guest", cancelReason: null });
    expect(feed.unread).toEqual({ all: 3, bookings: 3, needsAction: 0, updates: 0 });
    expect(feed.badge).toBe("blue");
  });

  it("says what a new booking still waits for", () => {
    const feed = buildHostNotificationFeed(
      sources({
        bookingEvents: [
          event({
            bookingId: "b0000000-0000-4000-8000-000000000011",
            lifecycleStatus: "pending_payment",
            paymentMethod: "bank_transfer",
          }),
          event({
            bookingId: "b0000000-0000-4000-8000-000000000012",
            lifecycleStatus: "pending_payment",
            hadHostDeadline: true,
          }),
          // Accepted since: no longer waiting, whatever the event said then.
          event({ bookingId: "b0000000-0000-4000-8000-000000000013", hadHostDeadline: true }),
        ],
      }),
      viewer,
    );
    expect(feed.items.map((item) => item.booking!.awaiting)).toEqual([
      "payment",
      "acceptance",
      null,
    ]);
  });

  it("turns a missed bank transfer into a red Needs action item, and nothing else", () => {
    const missed = event({
      eventType: "guest_booking.expired",
      actorType: "system",
      lifecycleStatus: "expired",
      paymentMethod: "bank_transfer",
      cancellationReason: "pending_booking_expired",
    });
    const acceptedUnpaid = event({
      eventType: "guest_booking.canceled",
      actorType: "system",
      lifecycleStatus: "canceled",
      paymentMethod: "bank_transfer",
      cancellationReason: "accepted_payment_expired",
      contactAccepted: true,
    });
    // A request the hotel never answered also expires with pending_booking_expired.
    const unanswered = event({
      eventType: "guest_booking.expired",
      actorType: "system",
      lifecycleStatus: "expired",
      paymentMethod: "bank_transfer",
      cancellationReason: "pending_booking_expired",
      hadHostDeadline: true,
    });
    const feed = buildHostNotificationFeed(
      sources({ bookingEvents: [missed, acceptedUnpaid, unanswered] }),
      viewer,
    );
    const byKey = new Map(feed.items.map((item) => [item.key, item]));

    expect(byKey.get(`booking-event:${missed.eventId}`)).toMatchObject({
      kind: "payment_not_received",
      category: "needs_action",
      booking: { guestEmail: null },
    });
    // The guest's email shows only once the property may see it (accepted booking or fixed plan).
    expect(byKey.get(`booking-event:${acceptedUnpaid.eventId}`)).toMatchObject({
      kind: "payment_not_received",
      booking: { guestEmail: "sarah@example.com" },
    });
    expect(byKey.get(`booking-event:${unanswered.eventId}`)).toMatchObject({
      kind: "booking_cancelled",
      booking: { cancelledBy: "system", cancelReason: "request_expired" },
    });
    expect(feed.unread.needsAction).toBe(2);
    expect(feed.badge).toBe("red");

    const fixedPlan = buildHostNotificationFeed(
      sources({ bookingEvents: [missed], guestContactAlways: true }),
      viewer,
    );
    expect(fixedPlan.items[0]!.booking!.guestEmail).toBe("sarah@example.com");
    const noContact = buildHostNotificationFeed(
      sources({ bookingEvents: [acceptedUnpaid], guestContactAlways: true }),
      { ...viewer, canReadGuestContact: false },
    );
    expect(noContact.items[0]!.booking!.guestEmail).toBeNull();
  });

  it("pins a failing channel sync until it recovers, as one item per failure episode", () => {
    const failing = {
      connectionId: "c0000000-0000-4000-8000-000000000001",
      domain: "ari" as const,
      lastAttemptAt: new Date("2026-10-25T14:50:00Z"),
      lastSuccessAt: new Date("2026-10-25T14:20:00Z"),
    };
    const feed = buildHostNotificationFeed(sources({ syncStatuses: [failing] }), viewer);
    expect(feed.syncAlert).toEqual({
      key: `channel-sync:${failing.connectionId}:ari.${failing.lastSuccessAt.getTime()}`,
      read: false,
      domains: ["ari"],
      failedAt: "2026-10-25T14:50:00.000Z",
      lastSuccessAt: "2026-10-25T14:20:00.000Z",
      canRetry: true,
      canViewDetails: true,
    });
    expect(feed.unread).toEqual({ all: 1, bookings: 0, needsAction: 1, updates: 0 });
    expect(feed.badge).toBe("red");

    const read = buildHostNotificationFeed(
      sources({ syncStatuses: [failing], readKeys: new Set([feed.syncAlert!.key]) }),
      { ...viewer, retrySyncDomains: [] },
    );
    expect(read.syncAlert).toMatchObject({ read: true, canRetry: false });
    expect(read.badge).toBe("none");

    // A later failure, after another success, is a new item.
    const again = buildHostNotificationFeed(
      sources({
        syncStatuses: [
          { ...failing, lastSuccessAt: new Date("2026-10-26T08:00:00Z") },
          { ...failing, domain: "booking", lastSuccessAt: null },
        ],
        readKeys: new Set([feed.syncAlert!.key]),
      }),
      viewer,
    );
    expect(again.syncAlert).toMatchObject({ read: false, domains: ["ari", "booking"] });
    expect(again.syncAlert!.lastSuccessAt).toBeNull();
    expect(again.syncAlert!.key).not.toBe(feed.syncAlert!.key);
  });

  it("lists ending and used-up promo codes only for people who may read promo codes", () => {
    const promos = [
      {
        id: "p0000000-0000-4000-8000-000000000001",
        code: "SUMMER25",
        validUntil: "2026-10-31",
        uses: 14,
        maxUses: 100,
        endingSince: new Date("2026-10-24T07:00:00Z"),
        limitReachedAt: null,
      },
      {
        id: "p0000000-0000-4000-8000-000000000002",
        code: "WELCOME10",
        validUntil: null,
        uses: 50,
        maxUses: 50,
        endingSince: null,
        limitReachedAt: new Date("2026-10-20T10:12:00Z"),
      },
    ];
    const feed = buildHostNotificationFeed(sources({ promos }), viewer);
    expect(feed.items).toEqual([
      expect.objectContaining({
        key: "promo-ending:p0000000-0000-4000-8000-000000000001:2026-10-31",
        kind: "promo_ending",
        category: "needs_action",
        promo: {
          id: promos[0]!.id,
          code: "SUMMER25",
          validUntil: "2026-10-31",
          uses: 14,
          maxUses: 100,
        },
      }),
      expect.objectContaining({
        key: "promo-limit:p0000000-0000-4000-8000-000000000002:50",
        kind: "promo_limit_reached",
      }),
    ]);
    expect(feed.badge).toBe("blue");

    const noPromos = { ...viewer, canReadPromos: false };
    expect(buildHostNotificationFeed(sources({ promos }), noPromos).items).toEqual([]);
    expect(
      readAllKeys(sources({ promos }), noPromos, { before: new Date(), syncAlertKey: null }),
    ).toEqual([]);
  });

  it("lists team members who joined under Updates", () => {
    const feed = buildHostNotificationFeed(
      sources({
        members: [
          {
            membershipId: "m0000000-0000-4000-8000-000000000001",
            joinedAt: new Date("2026-10-21T16:05:00Z"),
            name: "Anna Keller",
            role: "Front desk",
          },
        ],
      }),
      viewer,
    );
    expect(feed.items).toEqual([
      {
        key: "team-joined:m0000000-0000-4000-8000-000000000001",
        kind: "team_member_joined",
        category: "updates",
        occurredAt: "2026-10-21T16:05:00.000Z",
        read: false,
        member: { name: "Anna Keller", role: "Front desk" },
      },
    ]);
    expect(feed.unread.updates).toBe(1);
  });

  it("shows the newest 50 of each tab's kind, and counts every unread item of the 30 days", () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      event({ occurredAt: new Date(Date.UTC(2026, 9, 25, 9, index)) }),
    );
    const members = [
      {
        membershipId: "m0000000-0000-4000-8000-000000000001",
        joinedAt: new Date("2026-10-01T10:00:00Z"),
        name: null,
        role: "front_desk",
      },
    ];
    const readKeys = new Set([`booking-event:${events[0]!.eventId}`]);
    const feed = buildHostNotificationFeed(
      sources({ bookingEvents: events, members, readKeys }),
      viewer,
      new Date("2026-10-25T12:00:00Z"),
    );
    // The older team member still shows under Updates, behind 50 newer bookings.
    expect(feed.items).toHaveLength(51);
    expect(feed.items.filter((item) => item.category === "bookings")).toHaveLength(50);
    expect(feed.items[0]!.occurredAt).toBe("2026-10-25T09:59:00.000Z");
    expect(feed.items.at(-1)!.member).toEqual({ name: null, role: "front_desk" });
    expect(feed.unread).toEqual({ all: 60, bookings: 59, needsAction: 0, updates: 1 });
    expect(feed.generatedAt).toBe("2026-10-25T12:00:00.000Z");
  });

  it("marks all as the person saw them: earlier items and the sync card they were shown", () => {
    const earlier = event({ occurredAt: new Date("2026-10-25T09:00:00Z") });
    const later = event({ occurredAt: new Date("2026-10-25T09:05:00Z") });
    const failing = {
      connectionId: "c0000000-0000-4000-8000-000000000001",
      domain: "ari" as const,
      lastAttemptAt: new Date("2026-10-25T08:50:00Z"),
      lastSuccessAt: null,
    };
    const all = sources({ bookingEvents: [earlier, later], syncStatuses: [failing] });
    const alertKey = buildHostNotificationFeed(all, viewer).syncAlert!.key;
    expect(
      readAllKeys(all, viewer, {
        before: new Date("2026-10-25T09:01:00Z"),
        syncAlertKey: alertKey,
      }),
    ).toEqual([`booking-event:${earlier.eventId}`, alertKey]);
    // A sync card that changed since (another failure) stays unread.
    expect(
      readAllKeys(all, viewer, {
        before: new Date("2026-10-25T09:10:00Z"),
        syncAlertKey: "channel-sync:other",
      }),
    ).toEqual([`booking-event:${later.eventId}`, `booking-event:${earlier.eventId}`]);
  });

  it("lists a card booking once it is authorised or paid, never the checkout before it", () => {
    const card = { paymentMethod: "card" };
    const requested = "b0000000-0000-4000-8000-0000000000c1";
    const instant = "b0000000-0000-4000-8000-0000000000c2";
    const abandoned = "b0000000-0000-4000-8000-0000000000c3";
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 9, minute));
    const feed = buildHostNotificationFeed(
      sources({
        bookingEvents: [
          event({ ...card, bookingId: requested, occurredAt: at(0) }),
          event({
            ...card,
            bookingId: requested,
            eventType: "guest_booking.payment_authorized",
            actorType: "system",
            lifecycleStatus: "pending_payment",
            paymentStatus: "authorized",
            hadHostDeadline: true,
            occurredAt: at(1),
          }),
          event({ ...card, bookingId: instant, occurredAt: at(2) }),
          event({
            ...card,
            bookingId: instant,
            eventType: "guest_booking.payment_received",
            actorType: "system",
            paymentStatus: "paid",
            occurredAt: at(3),
          }),
          // Never paid: its checkout and its expiry stay out.
          event({ ...card, bookingId: abandoned, occurredAt: at(4) }),
          event({
            ...card,
            bookingId: abandoned,
            eventType: "guest_booking.expired",
            actorType: "system",
            lifecycleStatus: "expired",
            cancellationReason: "pending_booking_expired",
            occurredAt: at(34),
          }),
          // A bank transfer marked received by the hotel isn't a new booking.
          event({
            eventType: "guest_booking.payment_received",
            actorType: "property_user",
            paymentMethod: "bank_transfer",
            occurredAt: at(40),
          }),
        ],
      }),
      viewer,
    );
    expect(feed.items.map((item) => [item.kind, item.booking!.id, item.booking!.awaiting])).toEqual(
      [
        ["booking_new", instant, null],
        ["booking_new", requested, "acceptance"],
      ],
    );
  });

  it("offers Retry sync only for syncs the person can rerun", () => {
    const rows = [
      {
        connectionId: "c0000000-0000-4000-8000-000000000001",
        domain: "ari" as const,
        lastAttemptAt: new Date("2026-10-25T14:50:00Z"),
        lastSuccessAt: null,
      },
      {
        connectionId: "c0000000-0000-4000-8000-000000000001",
        domain: "booking" as const,
        lastAttemptAt: new Date("2026-10-25T14:50:00Z"),
        lastSuccessAt: null,
      },
    ];
    const retry = (domains: ("ari" | "booking")[]) =>
      buildHostNotificationFeed(sources({ syncStatuses: rows }), {
        ...viewer,
        retrySyncDomains: domains,
      }).syncAlert!.canRetry;
    expect(retry(["ari", "booking"])).toBe(true);
    expect(retry(["ari"])).toBe(false);
    expect(retry([])).toBe(false);
  });

  it("accepts only well-formed keys", () => {
    for (const key of [
      "booking-event:e0000001-0000-4000-8000-000000000000",
      "promo-ending:p0000000-0000-4000-8000-000000000001:2026-10-31",
      "channel-sync:c0000000-0000-4000-8000-000000000001:ari.1792893600000:booking.never",
    ])
      expect(isHostNotificationKey(key)).toBe(true);
    for (const key of [
      "",
      "booking-event:",
      "Booking:1",
      "booking-event:a b",
      42,
      null,
      "x:" + "a".repeat(201),
    ])
      expect(isHostNotificationKey(key)).toBe(false);
  });
});
