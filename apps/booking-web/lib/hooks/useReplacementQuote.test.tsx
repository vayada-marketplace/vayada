/** @vitest-environment jsdom */
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useReplacementQuote } from "./useReplacementQuote";
import { ApiError } from "@/services/api/client";
import { requestReplacementQuote } from "@/services/api/replacementQuote";
import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
vi.mock("@/services/api/replacementQuote", () => ({ requestReplacementQuote: vi.fn() }));
const request: PublicBookingQuoteRequest = {
  version: "public-booking-quote-request.v1",
  paymentMethod: "card",
  selection: {
    version: "public-pricing-selection.v1",
    checkIn: "2026-10-01",
    checkOut: "2026-10-02",
    currency: "EUR",
    addons: [],
    promoCode: null,
    rooms: [
      {
        selectionId: "one",
        publicOfferKey: "offer",
        guests: { adults: 1, childAgesAtCheckIn: [] },
      },
    ],
  },
};
const root = createRoot(document.createElement("div"));
let latest: ReturnType<typeof useReplacementQuote>;
function Harness({ slug, input }: { slug: string; input: PublicBookingQuoteRequest | null }) {
  const value = useReplacementQuote(slug, input);
  useEffect(() => {
    latest = value;
  });
  return null;
}
afterEach(async () => {
  await act(async () => root.render(null));
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("does not request until submitted, hides changed selections and ignores late replies", async () => {
  let finish!: (quote: Awaited<ReturnType<typeof requestReplacementQuote>>) => void;
  vi.mocked(requestReplacementQuote).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: request })));
  expect(requestReplacementQuote).not.toHaveBeenCalled();
  await act(async () => latest.submit());
  expect(latest.loading).toBe(true);
  const signal = vi.mocked(requestReplacementQuote).mock.calls[0][2]!;
  await act(async () => root.render(createElement(Harness, { slug: "other", input: request })));
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({ expiresAt: new Date(Date.now() + 1000).toISOString() } as Awaited<
      ReturnType<typeof requestReplacementQuote>
    >),
  );
  expect(latest.quote).toBeUndefined();
  expect(latest.loading).toBe(false);
});
it("marks a displayed price expired, preserves recovery context and allows explicit refresh", async () => {
  vi.useFakeTimers();
  vi.mocked(requestReplacementQuote).mockImplementation(
    async () =>
      ({ expiresAt: new Date(Date.now() + 1000).toISOString() }) as Awaited<
        ReturnType<typeof requestReplacementQuote>
      >,
  );
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: request })));
  await act(async () => latest.submit());
  expect(latest.quote).toBeDefined();
  await act(async () => vi.advanceTimersByTime(1001));
  expect(latest.quote).toBeDefined();
  expect(latest.error).toContain("expired");
  await act(async () => latest.submit());
  expect(latest.quote).toBeDefined();
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: null })));
  expect(latest.quote).toBeUndefined();
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: request })));
  expect(latest.quote).toBeUndefined();
  expect(requestReplacementQuote).toHaveBeenCalledTimes(2);
});

it("tells a refusal (with its status) from a failed request (VAY-2195)", async () => {
  vi.mocked(requestReplacementQuote).mockRejectedValueOnce(new ApiError("refused", 422, null));
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: request })));
  await act(async () => latest.submit());
  expect(latest.errorStatus).toBe(422);
  vi.mocked(requestReplacementQuote).mockRejectedValueOnce(new Error("offline"));
  await act(async () => latest.submit());
  expect(latest.error).toBeTruthy();
  expect(latest.errorStatus).toBeUndefined();
});
it("passes on why the hotel refused a quote, so /book can drop a switched-off code (VAY-2200)", async () => {
  vi.mocked(requestReplacementQuote).mockRejectedValueOnce(
    new ApiError("refused", 422, { code: "PROMO_CODES_UNAVAILABLE" }),
  );
  await act(async () => root.render(createElement(Harness, { slug: "hotel", input: request })));
  await act(async () => latest.submit());
  expect(latest).toMatchObject({ errorStatus: 422, errorCode: "PROMO_CODES_UNAVAILABLE" });
  vi.mocked(requestReplacementQuote).mockRejectedValueOnce(new ApiError("refused", 422, null));
  await act(async () => latest.submit());
  expect(latest.errorCode).toBeUndefined();
});
