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
    "Mon, 26 Oct",
    "from 14:00",
    "Tue, 27 Oct",
    "by 11:00",
    "1 night",
    "Includes taxes & fees",
    "Pay at the hotel or by bank transfer",
    "Instant confirmation by email",
    "Price held for you for 14:52 min",
  ])
    expect(text()).toContain(part);
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

it("counts the hold down and says when the price has run out", () => {
  render();
  act(() => vi.advanceTimersByTime(60_000));
  expect(text()).toContain("Price held for you for 13:52 min");
  act(() => vi.advanceTimersByTime(14 * 60_000));
  expect(text()).toContain("This price has expired.");
  expect(document.querySelector('[data-testid="stay-total"]')!.className).toContain("line-through");
});

it("speaks the page's language", () => {
  render({ methods: ["pay_at_property", "card"] }, "de");
  expect(document.querySelector("aside")!.getAttribute("aria-label")).toBe("Ihr Aufenthalt");
  expect(text()).toContain("Mo., 26. Okt.");
  expect(text()).toContain("Zahlung im Hotel oder mit Karte");
});
