/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import type { SelectedRoomLine } from "@/lib/types";
import RoomSelectionSummary from "./RoomSelectionSummary";

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrency: () => ({
    formatPrice: (amount: number, currency: string) => `${currency} ${amount}`,
  }),
}));

const line = (policy: Record<string, unknown>): SelectedRoomLine => ({
  roomTypeId: "alpine-suite",
  publicOfferKey: "alpine-suite:flex",
  guests: [{ adults: 2, children: 0 }],
  roomName: "Alpine Suite",
  roomCount: 1,
  rateSummary: { name: "Flexible rate", mealPlan: "breakfast", refundable: true },
  policy,
  totals: { totalAmount: "765", roomTotal: "765", taxesAndFees: "0", discounts: "0" },
});
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function render(props: { timezone?: string; locale?: string; policy?: Record<string, unknown> }) {
  const locale = props.locale ?? "en";
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(RoomSelectionSummary, {
          lines: [line(props.policy ?? { freeCancellationDeadlineDays: 7 })],
          currency: "EUR",
          checkIn: "2026-11-13",
          timezone: props.timezone,
        }),
      }),
    ),
  );
  return document.body.textContent ?? "";
}

it("says until when cancelling is free as a readable date in the hotel's time zone", () => {
  const text = render({ timezone: "Europe/Zurich" });
  expect(text).toContain("Free cancellation until Fri, 6 Nov 2026 (Central European Time).");
  expect(text).not.toContain("Nov 6, 2026");
  expect(text).not.toContain("Europe/Zurich");
});

it("falls back to UTC and follows the page's language", () => {
  expect(render({})).toContain("Free cancellation until Fri, 6 Nov 2026 (UTC).");
  expect(render({ timezone: "" })).toContain("Free cancellation until Fri, 6 Nov 2026 (UTC).");
  expect(render({ timezone: "Europe/Zurich", locale: "de" })).toContain(
    "Fr., 6. Nov. 2026 (Mitteleuropäische Zeit)",
  );
});

it("keeps the hotel's own words when the deadline can't be worked out", () => {
  const text = render({
    policy: { freeCancellationDeadlineDays: 400, cancellation: "Ask us first." },
  });
  expect(text).toContain("Ask us first.");
});
