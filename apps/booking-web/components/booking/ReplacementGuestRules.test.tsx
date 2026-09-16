/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import ReplacementGuestRules from "./ReplacementGuestRules";
import { getQuoteGuestDisclosure } from "@/services/api/quoteGuestDisclosure";
vi.mock("@/services/api/quoteGuestDisclosure", () => ({ getQuoteGuestDisclosure: vi.fn() }));
const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  issuedAt: "2026-09-14T00:00:00.000Z",
  expiresAt: "2026-09-14T00:05:00.000Z",
} as PublicBookingQuote;
const disclosure: PublicQuoteGuestDisclosure = {
  version: "public-quote-guest-disclosure.v1",
  quoteId: quote.quoteId,
  issuedAt: quote.issuedAt,
  expiresAt: quote.expiresAt,
  checkedAt: "2026-09-14T00:01:00.000Z",
  quoteEvidenceId: "sha256:" + "a".repeat(64),
  guestPolicyEvidenceId: "sha256:" + "b".repeat(64),
  propertyTimeZone: "Europe/Berlin",
  choices: {
    defaultGuestLanguage: "en",
    childrenEnabled: true,
    adultAgeThreshold: 12,
    phoneRequired: true,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: true,
    checkInTime: "15:00",
    checkOutTime: "11:00",
    checkInUntil: "00:00",
    checkOutFrom: "06:00",
  },
};
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(disclosure.checkedAt));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  vi.mocked(getQuoteGuestDisclosure).mockResolvedValue(disclosure);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (slug = "hotel", value = quote) => {
  await act(async () => root.render(createElement(ReplacementGuestRules, { slug, quote: value })));
};
const checkbox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
it("discloses every guest rule without inventing booking submission or dropping age information", async () => {
  await render();
  const text = document.body.textContent;
  for (const phrase of [
    "Europe/Berlin",
    "15:00",
    "midnight at the end of your arrival day",
    "from 06:00 by 11:00",
    "threshold is 12",
    "phone number is required",
    "do not collect an expected arrival time",
    "include special requests",
  ])
    expect(text).toContain(phrase);
  expect(checkbox().checked).toBe(false);
  expect(document.querySelector("button")).toBeNull();
});
it("resets acknowledgement on tenant and immutable quote changes", async () => {
  await render();
  act(() => checkbox().click());
  expect(checkbox().checked).toBe(true);
  await render("other");
  expect(checkbox().checked).toBe(false);
  act(() => checkbox().click());
  const next = { ...quote, quoteId: "22222222-2222-4222-8222-222222222222" };
  vi.mocked(getQuoteGuestDisclosure).mockResolvedValue({ ...disclosure, quoteId: next.quoteId });
  await render("other", next);
  expect(checkbox().checked).toBe(false);
});
it("aborts superseded reads and ignores a late result", async () => {
  let resolve!: (value: PublicQuoteGuestDisclosure) => void;
  vi.mocked(getQuoteGuestDisclosure).mockReturnValueOnce(
    new Promise((value) => {
      resolve = value;
    }),
  );
  await render();
  const firstSignal = vi.mocked(getQuoteGuestDisclosure).mock.calls[0][2]!;
  expect(document.body.textContent).toContain("Loading guest rules");
  await render("other");
  expect(firstSignal.aborted).toBe(true);
  await act(async () => resolve({ ...disclosure, propertyTimeZone: "Asia/Tokyo" }));
  expect(document.body.textContent).toContain("Europe/Berlin");
  expect(document.body.textContent).not.toContain("Asia/Tokyo");
});
it("fails closed on fetch failure and retries without prior agreement", async () => {
  vi.mocked(getQuoteGuestDisclosure).mockRejectedValueOnce(new Error("private diagnostic"));
  await render();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).not.toContain("private diagnostic");
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(checkbox().checked).toBe(false);
  expect(getQuoteGuestDisclosure).toHaveBeenCalledTimes(2);
});
it("refuses expired acknowledgement on interaction even before the parent retires the quote", async () => {
  await render();
  vi.setSystemTime(new Date(quote.expiresAt));
  act(() => checkbox().click());
  expect(checkbox().checked).toBe(false);
});
it("aborts disclosure reads when the quote preview unmounts", async () => {
  await render();
  const signal = vi.mocked(getQuoteGuestDisclosure).mock.calls[0][2]!;
  act(() => root.render(null));
  expect(signal.aborted).toBe(true);
});
