import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarBooking } from "@/services/calendar";

// The card's frame needs a browser; its content is what this test reads.
vi.mock("./CalendarPopover", () => ({
  default: ({ children }: { children: ReactNode }) => children,
  PopoverBadge: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));
vi.mock("@/lib/settings/useGuestStayTimes", () => ({ useGuestStayTimes: () => null }));
// English by default; a test can switch to German copy and number grouping.
const i18n = vi.hoisted(() => ({ messages: null as Record<string, string> | null }));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useTranslation: () => {
      const english = actual.useTranslation();
      const messages = i18n.messages;
      if (!messages) return english;
      return {
        ...english,
        locale: "de",
        t: (key: string, params: Record<string, string | number> = {}) =>
          Object.entries(params).reduce(
            (text, [name, param]) => text.split(`{${name}}`).join(String(param)),
            messages[key] ?? english.t(key),
          ),
      };
    },
  };
});

import deMessages from "../../messages/de.json";
import BookingPopover from "./BookingPopover";

const nights = [250, 300, 250, 250, 250, 300].map((amount, index) => ({
  date: ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"][
    index
  ]!,
  amount,
}));

const booking = (extra: Partial<CalendarBooking> = {}): CalendarBooking => ({
  id: "booking-1",
  roomTypeId: "villa",
  roomName: "Villa",
  guestFirstName: "Poole",
  guestLastName: "Emily",
  checkIn: "2026-11-27",
  checkOut: "2026-12-03",
  status: "confirmed",
  roomId: "room-1",
  roomNumber: "VILLA FOUR",
  channel: "booking.com",
  bookingReference: "VAY-1",
  numberOfRooms: 1,
  roomPosition: 0,
  assignmentId: "assignment-1",
  bookingValue: { amountDecimal: "1600.00", currency: "USD" },
  stayNights: 6,
  bookedNights: nights,
  ...extra,
});

function render(value: CalendarBooking) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      createElement(BookingPopover, {
        booking: value,
        roomLabel: "#VILLA FOUR",
        onChangeRoom: vi.fn(),
        onClose: vi.fn(),
      }),
    );
  });
  return view;
}

/** The popover's text pieces in reading order. */
const textOf = (node: ReactTestInstance | string): string[] =>
  typeof node === "string" ? [node] : node.children.flatMap(textOf);
const text = (view: ReactTestRenderer) => textOf(view.root).join("|");
const toggle = (view: ReactTestRenderer) =>
  view.root.findAllByType("button").find((button) => button.props["aria-expanded"] !== undefined);

describe("BookingPopover price per night (VAY-2576)", () => {
  afterEach(() => {
    i18n.messages = null;
  });

  it("shows the average, then each booked night and a total that is the booking value", () => {
    const view = render(booking());
    expect(text(view)).toContain("Price per night|$266.67| avg");
    expect(view.root.findAllByType("li")).toHaveLength(0);
    expect(toggle(view)?.props["aria-expanded"]).toBe(false);
    expect(text(view)).toContain("Show nightly rates");

    act(() => toggle(view)!.props.onClick());
    expect(toggle(view)?.props["aria-expanded"]).toBe(true);
    expect(text(view)).toContain("Hide nightly rates");
    const rows = text(view);
    expect(rows).toContain("Fri, Nov 27|$250|Sat, Nov 28|$300");
    expect(rows).toContain("Wed, Dec 2|$300|Total · 6 nights|$1,600");
    expect(rows).not.toContain("Fees and extras");
    // The list sits between the price and the arrival, as in the design.
    expect(rows.indexOf("Total · 6 nights")).toBeLessThan(rows.indexOf("Arrival"));
  });

  it("adds the fees and extras so the rows add up to the booking value", () => {
    const view = render(booking({ bookingValue: { amountDecimal: "1712.50", currency: "USD" } }));
    expect(text(view)).toContain("$266.67| avg");
    act(() => toggle(view)!.props.onClick());
    expect(text(view)).toContain("Fees and extras|$112.50|Total · 6 nights|$1,712.50");
    expect(text(view)).toContain("Fri, Nov 27|$250.00");
  });

  it("shows the booking value's average only, with no toggle, without a price for every night", () => {
    const view = render(booking({ bookedNights: null }));
    expect(text(view)).toContain("Price per night|$266.67| avg");
    expect(toggle(view)).toBeUndefined();
  });

  it("shows no average for an unverified amount", () => {
    const view = render(booking({ bookingValue: null }));
    expect(text(view)).toContain("Booking value|—|Price per night|—");
    expect(toggle(view)).toBeUndefined();
  });

  it("prices a booking of several rooms as a whole, like its value", () => {
    const view = render(
      booking({
        numberOfRooms: 2,
        bookingValue: { amountDecimal: "3200.00", currency: "USD" },
        bookedNights: nights.map((night) => ({ ...night, amount: night.amount * 2 })),
      }),
    );
    expect(text(view)).toContain("Price per night|$533.33| avg|for 2 rooms");
  });

  it("speaks German with German grouping, as the design's client view", () => {
    i18n.messages = deMessages;
    const amounts = [1_150_000, 1_150_000, 1_150_000, 1_150_000, 1_203_873, 1_203_873];
    const view = render(
      booking({
        checkIn: "2026-11-23",
        checkOut: "2026-11-29",
        bookingValue: { amountDecimal: "7007746.00", currency: "IDR" },
        bookedNights: amounts.map((amount, index) => ({
          date: `2026-11-${23 + index}`,
          amount,
        })),
      }),
    );
    expect(text(view)).toContain("Buchungswert|IDR 7.007.746|Preis pro Nacht|Ø |IDR 1.167.958");
    expect(text(view)).toContain("Preise pro Nacht anzeigen");
    act(() => toggle(view)!.props.onClick());
    expect(text(view)).toContain("Preise pro Nacht ausblenden");
    expect(text(view)).toContain("Mo., 23. Nov.|IDR 1.150.000");
    expect(text(view)).toContain("Sa., 28. Nov.|IDR 1.203.873|Gesamt · 6 Nächte|IDR 7.007.746");
  });
});
