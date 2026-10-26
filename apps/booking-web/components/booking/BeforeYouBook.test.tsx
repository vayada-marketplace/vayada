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
import BeforeYouBook from "./BeforeYouBook";

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
const render = (props: Record<string, unknown> = {}, locale = "en") =>
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(BeforeYouBook, {
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
          consentDisabled: false,
          onAgree: agree,
          ...props,
        }),
      }),
    ),
  );
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
    "Free cancellation ended",
    "From now until check-in· applies nowFull amount (US$175)",
    "Free cancellation ended on Fri, 23 Oct 2026. If you cancel or don’t arrive, you pay the full amount.",
  ])
    expect(text()).toContain(part);
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
  render();
  const box = document.querySelector<HTMLInputElement>("input[data-consent]")!;
  expect(box.closest("label")!.textContent).toBe(
    "I agree to the cancellation policy, guest rules and terms & conditions above.",
  );
  act(() => box.click());
  expect(agree).toHaveBeenCalledWith(true);
  render({ consentErrorId: "missing" });
  expect(document.getElementById("missing")!.textContent).toBe(
    "Tick the box to agree before you book.",
  );
  expect(box.getAttribute("aria-invalid")).toBe("true");
  render({ termsText: null });
  expect(document.querySelector("input[data-consent]")!.closest("label")!.textContent).toBe(
    "I agree to the cancellation policy and guest rules above.",
  );
});

it("offers a retry when the guest rules couldn't be checked", () => {
  render({ disclosure: null, rulesFailed: true, consentDisabled: true });
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
  expect(text()).toContain("Kostenlose Stornierung abgelaufen");
  expect(text()).toContain("Alle Zeiten in Ortszeit des Hotels (Sri Lanka).");
});
