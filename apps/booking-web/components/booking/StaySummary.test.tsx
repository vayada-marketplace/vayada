/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import { resetServerClock } from "@/lib/serverClock";
import StaySummary from "./StaySummary";

const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  checkIn: "2026-10-26",
  checkOut: "2026-10-27",
  currency: "USD",
  paymentMethod: "pay_at_property",
  acceptanceMode: "instant",
  issuedAt: "2026-10-25T10:00:00.000Z",
  expiresAt: "2026-10-25T10:15:00.000Z",
  totalMinor: "17500",
  dueNowMinor: "0",
  dueLaterMinor: "17500",
  lines: [{ kind: "room", selectionId: "a", amountMinor: "17500" }],
  rooms: [],
} as unknown as PublicBookingQuote;
const rules = { checkInTime: "14:00", checkOutTime: "11:00" } as never;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T10:00:08.000Z"));
  resetServerClock();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = (props: Record<string, unknown> = {}, locale = "en") =>
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(StaySummary, {
          quote,
          rooms: [{ selectionId: "a", name: "Villa Four", choice: "Flexible rate" }],
          guests: "2 adults",
          rules,
          formatMoney: (minor: string) => `US$${Number(minor) / 100}`,
          ...props,
        }),
      }),
    ),
  );
const text = () => document.querySelector("aside")!.textContent;

it("is the one summary: room, dates with the hotel's times, total and how to pay (VAY-2347)", () => {
  render({ methods: ["pay_at_property", "bank_transfer"] });
  const aside = document.querySelector("aside")!;
  expect(aside.getAttribute("aria-label")).toBe("Your stay");
  for (const part of [
    "Villa Four",
    "Flexible rate · 2 adults",
    "Mon 26 Oct",
    "from 14:00",
    "Tue 27 Oct",
    "by 11:00",
    "1 night",
    "Includes taxes & fees",
    "Pay at the hotel or by bank transfer",
    "Price held for you for 14:52 min",
  ])
    expect(text()).toContain(part);
  // A bank transfer is confirmed once the money arrives, so "instant" isn't promised beside it.
  expect(text()).not.toContain("Instant confirmation");
  render({ methods: ["pay_at_property"] });
  expect(text()).toContain("Pay at the hotelInstant confirmation by email");
  expect(aside.querySelector('[data-testid="stay-total"]')!.textContent).toBe("US$175");
});

it("shows the chosen way's payment lines on the payment step", () => {
  render({
    box: [
      { label: "Pay now", value: "US$0" },
      { label: "At the hotel", value: "US$175" },
    ],
    methods: ["pay_at_property"],
  });
  expect(text()).toContain("Pay nowUS$0At the hotelUS$175");
  expect(text()).not.toContain("Instant confirmation");
});

it("shows the discount row only for a real discount, not the quote's zero code line (VAY-2388)", () => {
  const withDiscounts = (...amounts: string[]) => ({
    ...quote,
    lines: [
      { kind: "room", selectionId: "a", amountMinor: "20000" },
      ...amounts.map((amountMinor, index) => ({
        kind: "discount",
        selectionId: index ? null : "a",
        amountMinor,
      })),
    ],
  });
  render({ quote: withDiscounts("0") });
  expect(text()).not.toContain("Discount");
  render({ quote: withDiscounts("0", "0") });
  expect(text()).not.toContain("Discount");
  // A last-minute discount on the room plus a promo code: one row with both.
  render({ quote: withDiscounts("2000", "500") });
  expect(text()).toContain("Discount−US$25");
});

it("counts the hold down and says when the price has run out", () => {
  render();
  act(() => vi.advanceTimersByTime(60_000));
  expect(text()).toContain("Price held for you for 13:52 min");
  act(() => vi.advanceTimersByTime(14 * 60_000));
  expect(text()).toContain("Price no longer held");
  expect(document.querySelector('[data-testid="stay-total"]')!.className).toContain("line-through");
});

it("speaks the page's language", () => {
  render({ methods: ["pay_at_property", "card"] }, "de");
  expect(document.querySelector("aside")!.getAttribute("aria-label")).toBe("Ihr Aufenthalt");
  expect(text()).toContain("Mo., 26. Okt.");
  expect(text()).toContain("Zahlung im Hotel oder mit Karte");
});

// VAY-2416: the checkout card carries the step's button, each extra and Change.
it("lists each extra and ends with the step's button", () => {
  const onChangeRoom = vi.fn();
  render({
    quote: {
      ...quote,
      totalMinor: "20500",
      lines: [...quote.lines, { kind: "addon", selectionId: null, amountMinor: "3000" }],
    },
    extras: [{ id: "x", name: "Airport transfer", price: "US$30", needsDay: false }],
    box: [
      { label: "Pay now", value: "US$0" },
      { label: "At the hotel", value: "US$205" },
    ],
    onChangeRoom,
    action: createElement("button", { type: "button" }, "Continue to your details"),
  });
  expect(text()).toContain("1 nightUS$175Airport transferUS$30Total");
  expect(text()).not.toContain("Extras");
  expect(text()).toContain("Pay nowUS$0At the hotelUS$205Continue to your details");
  const total = document.querySelector('[data-testid="stay-total"]')!;
  expect(total.getAttribute("role")).toBe("status");
  expect(total.getAttribute("aria-label")).toBe("Your stay total");
  act(() => (document.querySelector('[aria-label="Change Room 1"]') as HTMLButtonElement).click());
  expect(onChangeRoom).toHaveBeenCalledWith(0);
  // Phones: "Details" opens the lines above the total.
  const toggle = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Details",
  )!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(details.className).toContain("max-lg:hidden");
  act(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(details.className).not.toContain("max-lg:hidden");
});

it("stands without a price, and keeps one Extras line when the extras' prices don't add up", () => {
  render({
    quote: undefined,
    checkIn: "2026-10-26",
    checkOut: "2026-10-28",
    extras: [
      { id: "x", name: "Airport transfer", price: null, needsDay: false },
      { id: "y", name: "Late check-out", price: null, needsDay: true },
    ],
    pending: "Choose a day to see your total",
    action: null,
  });
  expect(text()).toContain("Mon 26 Oct");
  expect(text()).toContain("Wed 28 Oct");
  expect(text()).toContain("2 nights");
  expect(text()).toContain("Late check-outChoose a day");
  expect(document.querySelector('[data-testid="stay-total"]')!.textContent).toBe(
    "Choose a day to see your total",
  );
  expect(text()).not.toContain("Price held");
  render({
    quote: {
      ...quote,
      lines: [...quote.lines, { kind: "addon", selectionId: null, amountMinor: "3000" }],
    },
    extras: [{ id: "x", name: "Airport transfer", price: null, needsDay: false }],
  });
  expect(text()).toContain("Airport transferExtrasUS$30");
});

it("offers Change and, for a group, Remove on each room", () => {
  const onRemoveRoom = vi.fn();
  render({
    rooms: [
      { selectionId: "a", name: "Villa Four", choice: "Flexible rate", guests: "2 Adults" },
      { selectionId: "b", name: "Garden Room", choice: "Flexible rate", guests: "1 Adult" },
    ],
    onChangeRoom: () => {},
    onRemoveRoom,
    action: null,
  });
  expect(document.querySelector('[data-testid="stay-room-2"]')!.textContent).toContain(
    "Room 2 · Garden RoomFlexible rate · 1 Adult",
  );
  // A pointer's press (detail 1); a keyboard's has detail 0 and moves focus to Undo.
  act(() => {
    document
      .querySelector('[aria-label="Remove Room 2 from booking"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  expect(onRemoveRoom).toHaveBeenCalledWith(1, false);
  render({
    rooms: [{ selectionId: "a", name: "Villa Four", choice: "Flexible rate" }],
    locked: true,
    onChangeRoom: () => {},
  });
  expect(
    (document.querySelector('[aria-label="Change Room 1"]') as HTMLButtonElement).disabled,
  ).toBe(true);
});
