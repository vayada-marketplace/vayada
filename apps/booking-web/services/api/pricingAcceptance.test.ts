/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { acceptPricingQuote } from "./pricingAcceptance";

const quote = {
  version: "public-booking-quote.v1",
  quoteId: "11111111-1111-4111-8111-111111111111",
  replayed: false,
  checkIn: "2026-10-01",
  checkOut: "2026-10-03",
  currency: "EUR",
  paymentMethod: "pay_at_property",
  acceptanceMode: "instant",
  issuedAt: "2026-09-14T12:00:00.000Z",
  expiresAt: "2026-09-14T12:05:00.000Z",
  totalMinor: "20600",
  dueNowMinor: "0",
  dueLaterMinor: "20600",
  lines: [],
  rooms: [],
} as PublicBookingQuote;
const disclosure: PublicQuoteGuestDisclosure = {
  version: "public-quote-guest-disclosure.v1",
  quoteId: quote.quoteId,
  quoteEvidenceId: `sha256:${"a".repeat(64)}`,
  guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
  issuedAt: quote.issuedAt,
  expiresAt: quote.expiresAt,
  checkedAt: "2026-09-14T12:01:00.000Z",
  propertyTimeZone: "Europe/Berlin",
  choices: {
    defaultGuestLanguage: "en",
    childrenEnabled: true,
    adultAgeThreshold: 12,
    phoneRequired: true,
    arrivalTimeEnabled: true,
    specialRequestsEnabled: true,
    checkInTime: "15:00",
    checkOutTime: "11:00",
    checkInUntil: "00:00",
    checkOutFrom: "06:00",
  },
};
const guest = {
  firstName: " Ada ",
  lastName: " Lovelace ",
  email: " ADA@EXAMPLE.COM ",
  phone: " +49 123 ",
  countryCode: "de",
  arrivalTime: " 17:30 ",
  specialRequests: " Quiet room ",
};
const fresh = {
  kind: "accepted",
  bookingId: "22222222-2222-4222-8222-222222222222",
  bookingReference: "VAY-22222222222242228222222222222222",
  acceptanceId: "33333333-3333-4333-8333-333333333333",
  acceptedAt: "2026-09-14T12:01:01.000Z",
  checkedAt: "2026-09-14T12:01:02.000Z",
};
const fetcher = vi.fn<typeof fetch>();

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:01:00.000Z"));
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async () => new Response(JSON.stringify(fresh), { status: 200 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sent = (index: number) => {
  const init = fetcher.mock.calls[index]![1]!;
  return {
    body: JSON.parse(init.body as string),
    key: (init.headers as Record<string, string>)["Idempotency-Key"],
  };
};

it("binds normalized guest details and server evidence to the path and request key", async () => {
  await expect(acceptPricingQuote("hotel/name", quote, disclosure, guest)).resolves.toEqual(fresh);
  expect(fetcher.mock.calls[0]![0]).toBe(
    `/api/booking-web/hotels/hotel%2Fname/bookings/quotes/${quote.quoteId}/accept`,
  );
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: "no-store", method: "POST" });
  expect(sent(0).body).toEqual({
    version: "booking-quote-acceptance.v1",
    requestId: sent(0).key,
    quoteId: quote.quoteId,
    acceptance: {
      accepted: true,
      quoteEvidenceId: disclosure.quoteEvidenceId,
      guestPolicyEvidenceId: disclosure.guestPolicyEvidenceId,
    },
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "+49 123",
      countryCode: "DE",
      arrivalTime: "17:30",
      specialRequests: "Quiet room",
    },
  });
});

it("reuses uncertain retry keys and separates changed guest details", async () => {
  fetcher.mockRejectedValueOnce(new Error("network"));
  await expect(acceptPricingQuote("hotel", quote, disclosure, guest)).rejects.toThrow("network");
  await acceptPricingQuote("hotel", quote, disclosure, guest);
  await acceptPricingQuote("hotel", quote, disclosure, { ...guest, firstName: "Grace" });
  expect(sent(1).key).toBe(sent(0).key);
  expect(sent(2).key).not.toBe(sent(1).key);
});

it("rotates the exact key after a definite conflict", async () => {
  fetcher.mockResolvedValueOnce(new Response("{}", { status: 409 }));
  await expect(acceptPricingQuote("hotel", quote, disclosure, guest)).rejects.toMatchObject({
    status: 409,
  });
  await acceptPricingQuote("hotel", quote, disclosure, guest);
  expect(sent(1).key).not.toBe(sent(0).key);
});

it("refuses stale, mismatched and unsupported evidence before sending", async () => {
  for (const [candidateQuote, candidateDisclosure] of [
    [{ ...quote, acceptanceMode: "request" }, disclosure],
    [{ ...quote, paymentMethod: "card" }, disclosure],
    [quote, { ...disclosure, quoteEvidenceId: "unverified" }],
    [quote, { ...disclosure, quoteId: "other" }],
  ] as const)
    await expect(
      acceptPricingQuote("hotel", candidateQuote as PublicBookingQuote, candidateDisclosure, guest),
    ).rejects.toThrow("cannot be booked online");
  vi.setSystemTime(new Date(quote.expiresAt));
  await expect(acceptPricingQuote("hotel", quote, disclosure, guest)).rejects.toThrow(
    "cannot be booked online",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("accepts an exact replay and rejects malformed or private success payloads", async () => {
  const replay = {
    kind: "replayed",
    bookingId: fresh.bookingId,
    bookingReference: fresh.bookingReference,
    replayed: true,
  };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify(replay)));
  await expect(acceptPricingQuote("hotel", quote, disclosure, guest)).resolves.toEqual(replay);
  for (const invalid of [
    { ...fresh, private: true },
    { ...fresh, bookingId: "invalid" },
    { ...fresh, bookingReference: "private" },
    { ...fresh, checkedAt: "2026-09-14T12:00:00.000Z" },
    { ...replay, replayed: false },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(invalid)));
    await expect(acceptPricingQuote("hotel", quote, disclosure, guest)).rejects.toThrow(
      "confirmation could not be verified",
    );
  }
});

it("does not return a response after cancellation", async () => {
  const controller = new AbortController();
  fetcher.mockImplementationOnce(async () => {
    controller.abort();
    return new Response(JSON.stringify(fresh));
  });
  await expect(
    acceptPricingQuote("hotel", quote, disclosure, guest, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
