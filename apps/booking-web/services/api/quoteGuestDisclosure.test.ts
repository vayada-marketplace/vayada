import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { getQuoteGuestDisclosure } from "./quoteGuestDisclosure";
import { resetServerClock } from "@/lib/serverClock";
import { parsePublicQuoteGuestDisclosure } from "@vayada/domain-booking/replacement-pricing";
const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  issuedAt: "2026-09-14T00:00:00.000Z",
  expiresAt: "2026-09-14T00:05:00.000Z",
} as PublicBookingQuote;
const raw = {
  version: "public-quote-guest-disclosure.v1",
  quoteId: quote.quoteId,
  issuedAt: quote.issuedAt,
  expiresAt: quote.expiresAt,
  quoteEvidenceId: `sha256:${"a".repeat(64)}`,
  guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
  checkedAt: "2026-09-14T00:01:00.000Z",
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
beforeEach(() => {
  resetServerClock();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(raw.checkedAt));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const fetchResult = (value: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }),
      ),
  );
it("reads matching current public choices and exact server identities through the no-store route", async () => {
  fetchResult(raw);
  expect(await getQuoteGuestDisclosure("a/b", quote)).toEqual(raw);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining(`/a%2Fb/bookings/quotes/${quote.quoteId}/guest-disclosure`),
    expect.objectContaining({ cache: "no-store" }),
  );
});
it("rejects cross-quote, changed expiry, malformed identities/timezone/policies and private extras", () => {
  for (const patch of [
    { quoteId: "other" },
    { expiresAt: "2026-09-14T00:06:00.000Z" },
    { quoteEvidenceId: "unverified" },
    { guestPolicyEvidenceId: "bad" },
    { propertyTimeZone: "not/a-zone" },
    { checkedAt: quote.expiresAt },
    { checkedAt: "2026-09-13T23:59:59.000Z" },
    { quote: { private: true } },
    { choices: { ...raw.choices, checkInUntil: "12:00" } },
  ])
    expect(parsePublicQuoteGuestDisclosure({ ...raw, ...patch }, quote)).toBeNull();
});
it("fails at exact expiry on the server's clock", async () => {
  fetchResult(raw);
  await expect(getQuoteGuestDisclosure("hotel", quote)).resolves.toEqual(raw);
  // The older check time can't pull the server clock back: at expiry the answer is refused.
  vi.setSystemTime(new Date(quote.expiresAt));
  await expect(getQuoteGuestDisclosure("hotel", quote)).rejects.toThrow("could not be verified");
});
it.each([
  ["1 s behind", -1000],
  ["2 min behind", -120_000],
  ["1 s ahead", 1000],
  ["2 min ahead", 120_000],
  ["6 min ahead", 360_000],
])("accepts a valid answer when the device clock is %s (VAY-2134)", async (_label, skew) => {
  fetchResult(raw);
  vi.setSystemTime(Date.parse(raw.checkedAt) + skew);
  await expect(getQuoteGuestDisclosure("hotel", quote)).resolves.toEqual(raw);
});
it("rejects a superseded response even if transport ignores abort", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      controller.abort();
      return new Response(JSON.stringify(raw));
    }),
  );
  await expect(getQuoteGuestDisclosure("hotel", quote, controller.signal)).rejects.toThrow();
});
