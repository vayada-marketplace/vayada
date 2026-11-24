import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
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

import BookingPopover from "./BookingPopover";

const nights = [250, 300, 250, 250, 250, 300].map((amount, index) => ({
  date: ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"][index]!,
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

const text = (view: ReactTestRenderer) =>
  view.root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join("|");
const toggle = (view: ReactTestRenderer) =>
  view.root.findAllByType("button").find((button) => button.props["aria-expanded"] !== undefined);

describe("BookingPopover price per night (VAY-2576)", () => {
  it("shows the average, then each booked night and a total that is the booking value", () => {
    const view = render(booking());
    expect(text(view)).toContain("Price per night|$266.67| avg");
    expect(text(view)).not.toContain("Fri, Nov 27");
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
});
