import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const i18n = vi.hoisted(() => ({ lang: "en" as "en" | "de" }));
vi.mock("@/lib/i18n", async () => {
  const catalogs = {
    en: (await import("../../messages/en.json")).default as Record<string, string>,
    de: (await import("../../messages/de.json")).default as Record<string, string>,
  };
  // As the app's translate: the catalog's text with {params} filled in.
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      catalogs[i18n.lang][key] ?? key,
    );
  return { useTranslation: () => ({ t, locale: i18n.lang }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import type { ChannelManagerView as View } from "@/services/channelManager";

import { ChannelManagerView } from "./ChannelManagerView";
import { markupText } from "./channelManagerText";

// Local times, so the page's "today, 14:02" holds in any time zone the tests run in.
const now = new Date(2026, 10, 26, 15, 0);
const at = (hours: number, minutes: number, daysAgo = 0) =>
  new Date(2026, 10, 26 - daysAgo, hours, minutes).toISOString();

const connected: View = {
  contractVersion: "pms-channel-manager-view.v1",
  propertyId: "property-1",
  connection: { status: "connected" },
  channels: {
    status: "ok",
    items: [
      {
        ota: "booking_com",
        active: true,
        otaPropertyId: "4417201",
        mappedCount: 3,
        markup: {
          kind: "rules",
          rules: [{ operation: "increase_by_percent", value: "12" }],
          currency: "EUR",
        },
      },
      {
        ota: "airbnb",
        active: true,
        otaPropertyId: null,
        mappedCount: 3,
        markup: {
          kind: "rules",
          rules: [{ operation: "increase_by_percent", value: "10" }],
          currency: "EUR",
        },
      },
    ],
  },
  rooms: [
    {
      targetId: "t1",
      roomTypeId: "r1",
      roomTypeName: "Alpine Suite",
      mealPlan: "room_only",
      maxGuests: 2,
      selling: true,
      notSellingReason: null,
    },
    {
      targetId: "t2",
      roomTypeId: "r2",
      roomTypeName: "Garden Room",
      mealPlan: "room_only",
      maxGuests: 2,
      selling: true,
      notSellingReason: null,
    },
    {
      targetId: "t3",
      roomTypeId: "r3",
      roomTypeName: "Lake Loft",
      mealPlan: "room_only",
      maxGuests: 4,
      selling: false,
      notSellingReason: "no_open_nights",
    },
  ],
  sync: {
    prices: { status: "ok", lastSuccessAt: at(14, 2), retryAt: null },
    bookings: {
      status: "ok",
      lastCheckedAt: at(14, 10),
      latest: {
        channel: "booking_com",
        roomTypeName: "Garden Room",
        checkIn: "2026-12-12",
        checkOut: "2026-12-14",
      },
    },
  },
  problems: [],
};

const withProblems: View = {
  ...connected,
  sync: {
    ...connected.sync,
    prices: { status: "retrying", lastSuccessAt: at(13, 40), retryAt: at(14, 30) },
  },
  problems: [
    {
      id: "alert-1",
      eventType: "booking_not_imported",
      channel: "Airbnb",
      roomTypeName: "Garden Room",
      dateFrom: "2027-03-05",
      dateTo: "2027-03-07",
      reference: "HMABC123",
      errorType: "operational_inventory_unavailable",
      firstOccurredAt: at(9, 14),
      acknowledgedAt: null,
    },
  ],
};

function render(view: View, canMarkSeen = true, onMarkSeen = vi.fn()) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ChannelManagerView
        view={view}
        canMarkSeen={canMarkSeen}
        markingSeen={null}
        markSeenFailed={false}
        onMarkSeen={onMarkSeen}
        now={now}
      />,
    );
  });
  return renderer.root;
}

// Intl puts thin spaces around a date range's dash; compare with plain ones.
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string"
    ? node.replace(/[\u2009\u202f]/g, " ")
    : node.children.map(text).join("");
const buttons = (root: ReactTestInstance) => root.findAllByType("button").map(text);
const section = (root: ReactTestInstance, label: string) =>
  root.find((node) => node.type === "section" && node.props["aria-label"] === label);

describe("Channel manager page (VAY-2606, view only)", () => {
  it("shows a connected hotel with nothing to do, and no button that changes anything", () => {
    const root = render(connected);
    const page = text(root);
    expect(page).toContain("Connected");
    const channels = text(section(root, "Where your rooms sell"));
    expect(channels).toContain("Booking.comProperty 4417201 · 3 roomsSelling+12%");
    expect(channels).toContain("Airbnb3 listingsSelling+10%");
    expect(page).toContain("To change a markup or add a channel, contact the vayada team.");
    const rooms = text(section(root, "Rooms on Booking.com and Airbnb"));
    expect(rooms).toContain("Garden RoomRoom onlyUp to 2Selling");
    expect(rooms).toContain("Lake LoftRoom onlyUp to 4Not selling");
    expect(rooms).toContain(
      "Lake Loft has no open nights in the next 12 months. Open nights in the calendar to sell it.",
    );
    const sync = text(section(root, "Sync"));
    expect(sync).toContain("Up to date · last sent today, 14:02");
    expect(sync).toContain("Up to date · last checked today, 14:10");
    expect(sync).toContain("Latest: Booking.com, Garden Room, Dec 12");
    expect(text(section(root, "Problems"))).toContain("Nothing needs your attention.");
    expect(buttons(root)).toEqual([]);
    expect(page).not.toMatch(/Sync now|Enable connection|Open channel settings/);
  });

  it("words problems plainly and lets an account admin mark one as seen", () => {
    const onMarkSeen = vi.fn();
    const root = render(withProblems, true, onMarkSeen);
    expect(text(root)).toContain("Needs attention");
    const problems = text(section(root, "Problems"));
    expect(problems).toContain("2 open");
    expect(problems).not.toContain("only account admins");
    expect(problems).toContain("A booking from Airbnb couldn't be added");
    expect(problems).toContain(
      "Garden Room is already booked for Mar 5 – 7, 2027, so this stay is sold twice. Move one guest to another room, or ask Airbnb to cancel.",
    );
    expect(problems).toContain("Airbnb · Garden Room · Mar 5 – 7, 2027 · first seen today, 09:14");
    expect(problems).toContain("New prices haven't reached Booking.com and Airbnb yet");
    expect(problems).toContain("We try again by ourselves, next at 14:30. Nothing to do for now.");
    expect(text(section(root, "Sync"))).toContain(
      "Trying again by itself · last sent today, 13:40",
    );
    // Only the booking problem can be seen; the prices clear by themselves.
    expect(buttons(root)).toEqual(["Mark as seen"]);
    expect(
      root.findAll((node) => node.type === "a" && node.props.href === "/calendar").map(text),
    ).toEqual(["Open calendar"]);
    act(() => root.findByType("button").props.onClick());
    expect(onMarkSeen).toHaveBeenCalledWith("alert-1");
  });

  it("shows staff the same problems without Mark as seen", () => {
    const root = render(withProblems, false);
    expect(text(section(root, "Problems"))).toContain(
      "2 open · only account admins can mark them as seen",
    );
    expect(buttons(root)).toEqual([]);
    expect(
      root.findAll((node) => node.type === "a" && node.props.href === "/calendar"),
    ).toHaveLength(1);
  });

  it("keeps a seen problem listed, without the badge asking for attention", () => {
    const seen: View = {
      ...connected,
      problems: [{ ...withProblems.problems[0]!, acknowledgedAt: at(10, 0) }],
    };
    const root = render(seen);
    expect(text(root)).toContain("Connected");
    expect(text(section(root, "Problems"))).toContain("Seen");
    expect(buttons(root)).toEqual([]);
  });

  it("says when only some rooms went out or new bookings aren't checked, without claiming retries", () => {
    const root = render({
      ...connected,
      sync: {
        prices: { status: "partial", lastSuccessAt: at(14, 2), retryAt: null },
        bookings: { status: "failed", lastCheckedAt: at(9, 14), latest: null },
      },
      problems: [
        {
          ...withProblems.problems[0]!,
          id: "alert-2",
          eventType: "non_acked_booking",
          channel: "BookingCom",
          errorType: null,
        },
      ],
    });
    expect(text(root)).toContain("Needs attention");
    const problems = text(section(root, "Problems"));
    expect(problems).toContain("3 open");
    expect(problems).toContain("Some rooms' prices didn't reach Booking.com and Airbnb");
    expect(problems).toContain("New bookings aren't coming in");
    expect(problems).toContain(
      "We haven't been able to check Booking.com and Airbnb for new bookings since today, 09:14.",
    );
    expect(problems).toContain("A booking from Booking.com is still being confirmed");
    expect(problems).toContain(
      "If it isn't in your PMS, find it in your Booking.com extranet (reference HMABC123)",
    );
    expect(problems).not.toContain("Nothing to do for now");
    const sync = text(section(root, "Sync"));
    expect(sync).toContain("Some rooms left out · last sent today, 14:02");
    expect(sync).toContain("Not working · last checked today, 09:14");
  });

  it("asks a hotel without a connection to contact the vayada team", () => {
    const root = render({
      ...connected,
      connection: { status: "disconnected" },
      channels: { status: "unavailable" },
      rooms: [],
    });
    expect(text(root)).toContain("Not connected");
    expect(text(root)).toContain("Booking.com and Airbnb aren't connected yet");
    const link = root.find((node) => node.type === "a" && text(node) === "Contact the vayada team");
    expect(link.props.href).toBe("https://vayada.com/contact");
    expect(link.props.target).toBe("_blank");
    expect(root.findAll((node) => node.props["aria-label"] === "Where your rooms sell")).toEqual(
      [],
    );
  });

  it("still shows the rest of the page when Channex can't be read", () => {
    const root = render({ ...connected, channels: { status: "unavailable" } });
    expect(text(section(root, "Where your rooms sell"))).toContain(
      "Booking.com and Airbnb couldn't be read just now.",
    );
    expect(text(root)).toContain("Garden Room");
  });

  it("reads in German", () => {
    i18n.lang = "de";
    try {
      const root = render(withProblems, false);
      expect(text(root)).toContain("Braucht Aufmerksamkeit");
      expect(text(root)).toContain("nur Konto-Admins können sie als gesehen markieren");
      expect(text(root)).toContain("Eine Buchung von Airbnb konnte nicht angelegt werden");
    } finally {
      i18n.lang = "en";
    }
  });
});

describe("markup as the page shows it", () => {
  const t = (key: string) =>
    ({
      "channelManager.channels.markupNone": "None",
      "channelManager.channels.markupVaries": "Varies by room",
      "channelManager.channels.markupThen": "then",
    })[key] ?? key;

  it.each([
    [{ kind: "rules", rules: [], currency: "EUR" }, "None"],
    [
      { kind: "rules", rules: [{ operation: "increase_by_percent", value: "12" }], currency: null },
      "+12%",
    ],
    [
      {
        kind: "rules",
        rules: [{ operation: "decrease_by_percent", value: "2.5" }],
        currency: null,
      },
      "−2.5%",
    ],
    [
      {
        kind: "rules",
        rules: [{ operation: "increase_by_percent", value: "21.17" }],
        currency: "EUR",
      },
      "+21.17%",
    ],
    [
      {
        kind: "rules",
        rules: [
          { operation: "increase_by_percent", value: "5.00" },
          { operation: "increase_by_amount", value: "12.00" },
        ],
        currency: "EUR",
      },
      "+5% then +€12.00",
    ],
    [{ kind: "varies" }, "Varies by room"],
    [{ kind: "unknown" }, "—"],
  ] as const)("%j reads %s", (markup, expected) => {
    expect(markupText(markup, "en", t)).toBe(expected);
  });
});
