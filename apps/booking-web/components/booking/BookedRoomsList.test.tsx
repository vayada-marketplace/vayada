/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import id from "@/messages/id.json";
import type { BookedRoom } from "@/lib/types";
import BookedRoomsList from "./BookedRoomsList";

const room = (cancellation: BookedRoom["cancellation"]): BookedRoom => ({
  roomTypeId: "deluxe",
  roomName: "Deluxe",
  mealPlan: "room_only",
  adults: 2,
  children: 0,
  cancellation,
});

function lines(locale: string, messages: Record<string, unknown>, rooms: BookedRoom[]) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages,
        children: createElement(BookedRoomsList, {
          rooms,
          checkIn: "2026-11-10",
          timezone: "Europe/Berlin",
          labelClass: "",
        }),
      }),
    ),
  );
  const text = Array.from(
    container.querySelectorAll("p.text-sm.text-gray-600"),
    (p) => p.textContent,
  );
  act(() => root.unmount());
  return text;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Two days before arrival: past a partial refund's last refund day 5 days before, not yet past one on arrival day.
  vi.useFakeTimers({ now: new Date("2026-11-08T12:00:00Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// VAY-2428: a booked partial refund past its last refund day reads as no refund, as Review & pay says.
it.each([
  ["en", en],
  ["de", de],
  ["fr", fr],
  ["es", es],
  ["id", id],
])(
  "says a partial refund past its last refund day refunds nothing any more (%s)",
  (locale, messages) => {
    const choice = messages.home.choice;
    const [passed, open, unknownDay, free] = lines(locale, messages, [
      room({ kind: "partial_refund", days: 5 }),
      room({ kind: "partial_refund", days: 0 }),
      room({ kind: "partial_refund" }),
      room({ kind: "free_until_days_before_arrival", days: 3 }),
    ]);
    expect(passed).toBe(`${messages.confirmation.noMeals} · ${choice.refundsEnded}`);
    expect(open).toContain(choice.partialRefundTerms);
    expect(unknownDay).toContain(choice.partialRefundTerms);
    expect(free).toBe(`${messages.confirmation.noMeals} · ${choice.freeEnded}`);
  },
);
