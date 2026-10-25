/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import ReplacementQuoteTerms, { type ReplacementQuoteTermsProps } from "./ReplacementQuoteTerms";

const quote: PublicBookingQuote = {
  version: "public-booking-quote.v1",
  quoteId: "11111111-1111-4111-8111-111111111111",
  replayed: false,
  checkIn: "2027-02-01",
  checkOut: "2027-02-03",
  currency: "EUR",
  paymentMethod: "pay_at_property",
  acceptanceMode: "instant",
  issuedAt: "2027-01-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:05:00.000Z",
  totalMinor: "30000",
  dueNowMinor: "0",
  dueLaterMinor: "30000",
  lines: [
    { kind: "room", selectionId: "a", amountMinor: "10000" },
    { kind: "room", selectionId: "b", amountMinor: "20000" },
  ],
  rooms: [
    {
      selectionId: "a",
      mealPlan: "breakfast",
      cancellation: {
        kind: "flexible",
        terms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
          text: "Contact us with cancellation requests.\nKeep your reference.",
        },
      },
      payment: { kind: "full", acceptedMethods: ["card", "pay_at_property"] },
    },
    {
      selectionId: "b",
      mealPlan: "room_only",
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    },
  ],
};
const roomNames = { a: "Garden suite", b: "Garden suite" };
let root: Root;
let change = vi.fn<NonNullable<ReplacementQuoteTermsProps["onAcknowledgementChange"]>>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(quote.issuedAt));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  change = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function render(props: Partial<ReplacementQuoteTermsProps> = {}) {
  act(() =>
    root.render(
      createElement(ReplacementQuoteTerms, {
        quote,
        roomNames,
        onAcknowledgementChange: change,
        // The hotel's date when the quote was issued.
        today: "2027-01-01",
        ...props,
      }),
    ),
  );
}
const checkbox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const acknowledge = () => act(() => checkbox().click());

it("discloses each physical room's actual name, meal, cancellation and payment terms", () => {
  render();
  const rooms = document.querySelectorAll("section[aria-label]");
  expect(rooms).toHaveLength(2);
  expect(rooms[0].textContent).toContain("Room 1: Garden suite");
  expect(rooms[0].textContent).toContain("Meals: Breakfast");
  expect(rooms[0].textContent).toContain(
    "Free cancellation deadline: the end of Mon, 25 Jan 2027, local hotel time (7 days before arrival).",
  );
  expect(rooms[0].textContent).toContain("After-deadline penalty: full booking amount.");
  expect(rooms[0].textContent).toContain("No-show penalty: full booking amount.");
  expect(rooms[0].textContent).toContain(
    "Contact us with cancellation requests.\nKeep your reference.",
  );
  expect(rooms[0].textContent).toContain("Accepted methods: Card, Pay at the hotel.");
  expect(rooms[1].textContent).toContain("Room 2: Garden suite");
  expect(rooms[1].textContent).toContain("Room only (no meals)");
  expect(rooms[1].textContent).toContain("Non-refundable.");
  expect(rooms[1].textContent).not.toContain("Free cancellation");
  expect(document.body.textContent).toContain("Please also review our guest rules");
  expect(document.querySelector("button")).toBeNull();
  expect(checkbox().closest("label")?.textContent).toContain("price preview");
});

it("shows partial-refund steps alone, most notice first, without a free-cancellation deadline", () => {
  const partial = structuredClone(quote);
  const cancellation = partial.rooms[0].cancellation;
  if (cancellation.kind !== "flexible") throw new Error("fixture");
  Object.assign(cancellation.terms, {
    freeCancellationDeadlineDays: 365,
    flexibleCancellationType: "partial_refund",
    partialRefundCancelWindowDays: 30,
    partialRefundAmountPercent: 50,
    partialRefundTiers: [
      { minDaysBeforeCheckIn: 14, refundPercent: 50 },
      { minDaysBeforeCheckIn: 30, refundPercent: 75 },
      { minDaysBeforeCheckIn: 7, refundPercent: 0 },
    ],
  });
  render({ quote: partial });
  const room = document.querySelector('section[aria-label="Room 1 terms"]')!.textContent;
  expect(room).toContain("Cancellation type: Partial refund.");
  expect(Array.from(document.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
    "75% refund if you cancel by the end of Sat, 2 Jan 2027 (at least 30 days before check-in).",
    "50% refund if you cancel by the end of Mon, 18 Jan 2027 (at least 14 days before check-in).",
    "0% refund if you cancel by the end of Mon, 25 Jan 2027 (at least 7 days before check-in).",
  ]);
  expect(room).toContain("No refund after Mon, 25 Jan 2027 (less than 7 days before check-in).");
  expect(room).toContain("No-show penalty: full booking amount.");
  expect(room).not.toMatch(/Free cancellation deadline|After-deadline penalty|window|amount: 50%/);
  expect(document.body.textContent).not.toMatch(/midnight|23:59|2027-01-25/);
});

it("adds no less-notice line when a step starts at check-in", () => {
  const partial = structuredClone(quote);
  const cancellation = partial.rooms[0].cancellation;
  if (cancellation.kind !== "flexible") throw new Error("fixture");
  Object.assign(cancellation.terms, {
    flexibleCancellationType: "partial_refund",
    partialRefundTiers: [{ minDaysBeforeCheckIn: 0, refundPercent: 20 }],
  });
  render({ quote: partial });
  expect(document.body.textContent).toContain(
    "20% refund if you cancel by the end of Mon, 1 Feb 2027 (at least 0 days before check-in).",
  );
  expect(document.body.textContent).not.toContain("No refund after");
});

it("says a deadline that has passed for this stay has passed (VAY-2347)", () => {
  render({ today: "2027-01-26" });
  expect(document.querySelector('section[aria-label="Room 1 terms"]')!.textContent).toContain(
    "Free cancellation deadline: Mon, 25 Jan 2027 (7 days before arrival). It has passed, so free cancellation no longer applies to this stay.",
  );
  const partial = structuredClone(quote);
  const cancellation = partial.rooms[0].cancellation;
  if (cancellation.kind !== "flexible") throw new Error("fixture");
  Object.assign(cancellation.terms, {
    flexibleCancellationType: "partial_refund",
    partialRefundTiers: [
      { minDaysBeforeCheckIn: 30, refundPercent: 75 },
      { minDaysBeforeCheckIn: 7, refundPercent: 50 },
    ],
  });
  render({ quote: partial, today: "2027-01-20" });
  expect(Array.from(document.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
    "75% refund until the end of Sat, 2 Jan 2027 (at least 30 days before check-in): this date has passed.",
    "50% refund if you cancel by the end of Mon, 25 Jan 2027 (at least 7 days before check-in).",
  ]);
});

it("binds acknowledgement to evidence and ignores the replay transport flag", () => {
  render();
  acknowledge();
  const accepted = change.mock.lastCall![0]!;
  expect(accepted.quoteId).toBe(quote.quoteId);
  expect(accepted.termsIdentity).toContain("Garden suite");
  render({ quote: { ...quote, replayed: true } });
  expect(checkbox().checked).toBe(true);
  render({
    quote: { ...quote, rooms: [{ ...quote.rooms[0], mealPlan: "half_board" }, quote.rooms[1]] },
  });
  expect(checkbox().checked).toBe(false);
  expect(change).toHaveBeenLastCalledWith(null);
});

it("resets on a new quote, changed room label and stale selection without restoring prior agreement", () => {
  render();
  acknowledge();
  render({ quote: { ...quote, quoteId: "22222222-2222-4222-8222-222222222222" } });
  expect(checkbox().checked).toBe(false);
  render();
  acknowledge();
  render({ roomNames: { ...roomNames, a: "Sea suite" } });
  expect(checkbox().checked).toBe(false);
  render();
  acknowledge();
  render({ stale: true });
  expect(checkbox().disabled).toBe(true);
  expect(change).toHaveBeenLastCalledWith(null);
  render();
  expect(checkbox().checked).toBe(false);
});

it("revokes acknowledgement at exact expiry and on unmount", () => {
  render();
  acknowledge();
  act(() => vi.advanceTimersByTime(300000));
  expect(checkbox().disabled).toBe(true);
  expect(checkbox().checked).toBe(false);
  expect(change).toHaveBeenLastCalledWith(null);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("no longer current");
  vi.setSystemTime(new Date(quote.issuedAt));
  render({ quote: { ...quote, quoteId: "22222222-2222-4222-8222-222222222222" } });
  acknowledge();
  act(() => root.render(null));
  expect(change).toHaveBeenLastCalledWith(null);
});

it("does not block a quote issued after the device clock (VAY-2134)", () => {
  render({ quote: { ...quote, issuedAt: "2027-01-01T00:01:00.000Z" } });
  expect(checkbox().disabled).toBe(false);
});

it("blocks agreement for expired or unnamed rooms", () => {
  render({ roomNames: {} });
  expect(checkbox().disabled).toBe(true);
  expect(document.body.textContent).toContain("Room details are unavailable");
  vi.setSystemTime(new Date(quote.expiresAt));
  render();
  expect(checkbox().disabled).toBe(true);
});

it("shows the frozen confirmation mode and revokes agreement when it changes", () => {
  render();
  expect(document.body.textContent).toContain("No separate approval from us is needed.");
  expect(document.body.textContent).not.toContain("Your booking will need our approval.");
  acknowledge();
  render({ quote: { ...quote, acceptanceMode: "request" } });
  expect(document.body.textContent).toContain("Your booking will need our approval.");
  expect(document.body.textContent).toContain("Sending a request does not confirm your stay.");
  expect(document.body.textContent).not.toContain("No separate approval from us is needed.");
  expect(checkbox().checked).toBe(false);
  expect(change).toHaveBeenLastCalledWith(null);
  expect(document.body.textContent).toContain(
    "This price preview does not reserve a room or take payment.",
  );
});

it("shows the tick first and the terms behind Read on the payment step (VAY-2195)", () => {
  render({ compact: true });
  expect(document.body.textContent).toContain(
    "I have read the room and rate terms for this price.",
  );
  expect(document.body.textContent).not.toContain("Free cancellation deadline");
  const read = () =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("terms"))!;
  act(() => read().click());
  expect(read().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  acknowledge();
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ quoteId: quote.quoteId }));
});
