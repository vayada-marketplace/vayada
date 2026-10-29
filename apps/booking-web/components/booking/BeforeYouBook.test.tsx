/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import BeforeYouBook, { BookingConsent } from "./BeforeYouBook";

const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  checkIn: "2026-10-26",
  checkOut: "2026-10-27",
  currency: "USD",
  paymentMethod: "pay_at_property",
  acceptanceMode: "instant",
  totalMinor: "17500",
  lines: [{ kind: "room", selectionId: "a", amountMinor: "17500" }],
  rooms: [
    {
      selectionId: "a",
      mealPlan: "room_only",
      cancellation: {
        kind: "flexible",
        terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: 3 },
      },
    },
  ],
} as unknown as PublicBookingQuote;
const disclosure = {
  quoteId: quote.quoteId,
  choices: {
    checkInTime: "14:00",
    checkOutTime: "11:00",
    childrenEnabled: true,
    adultAgeThreshold: 18,
    phoneRequired: true,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: true,
  },
} as unknown as PublicQuoteGuestDisclosure;
let root: Root;
const agree = vi.fn();
const retry = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  agree.mockClear();
  retry.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
// "Before you book" on the left and its tick in "Your stay" (VAY-2416), from the same props.
const render = (props: Record<string, unknown> = {}, locale = "en") => {
  const all = {
    quote,
    disclosure,
    rulesFailed: false,
    onRetryRules: retry,
    roomNames: { a: "Villa Four" },
    today: "2026-10-25",
    hotelCountry: "Sri Lanka",
    termsText: "Quiet hours from 22:00.",
    formatMoney: (minor: string) => `US$${Number(minor) / 100}`,
    agreed: false,
    disabled: false,
    onAgree: agree,
    ...props,
  } as Parameters<typeof BeforeYouBook>[0] & Parameters<typeof BookingConsent>[0];
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: [
          createElement(BeforeYouBook, { key: "before", ...all }),
          createElement(BookingConsent, { key: "consent", ...all }),
        ],
      }),
    ),
  );
};
const text = () => document.body.textContent ?? "";
const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(name))!;

it("shows the quick facts, local hotel time and the policy for this stay (VAY-2347)", () => {
  render();
  for (const part of [
    "Check-inFrom 14:00",
    "Check-outBy 11:00",
    "MealsRoom only",
    "ChildrenWelcome · 18+ count as adults",
    "All times are local hotel time (Sri Lanka).",
    // VAY-2392: booked after free cancellation's last day (23 Oct), it was never refundable.
    "Non-refundable",
    "From now until check-in· applies nowFull amount (US$175)",
    "You’re booking less than 3 days before arrival, so this booking can’t be cancelled for free. If you cancel or don’t arrive, you pay the full amount.",
  ])
    expect(text()).toContain(part);
  expect(text()).not.toContain("Free cancellation ended");
  const now = document.querySelector('[role="row"][aria-current="true"]')!;
  expect(now.textContent).toContain("From now until check-in");
});

it("keeps the guest rules and terms closed until opened", () => {
  render();
  expect(document.querySelector('[role="region"][aria-label="Guest rules"]')).toBeNull();
  act(() => button("Guest rules").click());
  const rules = document.querySelector('[role="region"][aria-label="Guest rules"]')!.textContent;
  expect(rules).toContain("Check-in from 14:00.");
  expect(rules).toContain("Guests from 18 count as adults.");
  expect(rules).toContain("Arrival time isn’t collected online.");
  act(() => button("Terms & conditions").click());
  expect(
    document.querySelector('[role="region"][aria-label="Terms & conditions"]')!.textContent,
  ).toBe("Quiet hours from 22:00.");
});

it("agrees to everything with one tick and says why when it was missed", () => {
  render({ today: "2026-10-01" });
  const box = document.querySelector<HTMLInputElement>("input[data-consent]")!;
  expect(box.closest("label")!.textContent).toBe(
    "I agree to the cancellation policy, guest rules and terms & conditions.",
  );
  act(() => box.click());
  expect(agree).toHaveBeenCalledWith(true);
  render({ errorId: "missing" });
  expect(document.getElementById("missing")!.textContent).toBe(
    "Please tick the box to confirm your booking.",
  );
  expect(box.getAttribute("aria-invalid")).toBe("true");
  render({ termsText: null, today: "2026-10-01" });
  expect(document.querySelector("input[data-consent]")!.closest("label")!.textContent).toBe(
    "I agree to the cancellation policy and guest rules.",
  );
});

it("says first in the consent when rooms can't be refunded (VAY-2392)", () => {
  const label = () => document.querySelector("input[data-consent]")!.closest("label")!.textContent;
  render();
  expect(label()).toBe(
    "I understand this booking is non-refundable. If I cancel or don’t arrive, the full stay is charged. I agree to the cancellation policy, guest rules and terms & conditions.",
  );
  // One room still free to cancel, one not.
  const mixed = {
    ...quote,
    lines: [...quote.lines, { kind: "room", selectionId: "b", amountMinor: "17500" }],
    totalMinor: "35000",
    rooms: [
      ...quote.rooms,
      { selectionId: "b", mealPlan: "room_only", cancellation: { kind: "non_refundable" } },
    ],
  } as unknown as PublicBookingQuote;
  // While a request waits for us, cancelling is still free: no such sentence.
  render({ quote: { ...quote, acceptanceMode: "request" } });
  expect(label()).toBe("I agree to the cancellation policy, guest rules and terms & conditions.");
  render({ quote: mixed, today: "2026-10-01", roomNames: { a: "Villa Four", b: "Garden" } });
  expect(label()).toBe(
    "I understand some of these rooms are non-refundable. If I cancel or don’t arrive, their full price is charged. I agree to the cancellation policy, guest rules and terms & conditions.",
  );
});

it("offers a retry when the guest rules couldn't be checked", () => {
  render({ disclosure: null, rulesFailed: true, disabled: true });
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "We couldn’t check the hotel’s guest rules for this price.",
  );
  act(() => button("Try again").click());
  expect(retry).toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>("input[data-consent]")!.disabled).toBe(true);
});

it("speaks the page's language", () => {
  render({}, "de");
  expect(text()).toContain("Vor der Buchung");
  expect(text()).toContain("Nicht erstattbar");
  expect(text()).toContain("Alle Zeiten in Ortszeit des Hotels (Sri Lanka).");
});
