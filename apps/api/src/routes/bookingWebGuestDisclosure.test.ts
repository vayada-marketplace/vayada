import Fastify, { type FastifyInstance } from "fastify";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lockCurrentQuoteGuestDisclosure } from "../domains/currentQuoteGuestDisclosure.js";
import { readBookingAffiliateContextForQuote } from "../domains/bookingAffiliateContextForQuote.js";
import {
  PricingAcceptanceError,
  writePricingAcceptance,
} from "../domains/pricingAcceptanceWriter.js";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
} from "./bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";
vi.mock("../domains/currentQuoteGuestDisclosure.js", () => ({
  lockCurrentQuoteGuestDisclosure: vi.fn(),
}));
vi.mock("../domains/bookingAffiliateContextForQuote.js", () => ({
  readBookingAffiliateContextForQuote: vi.fn(),
}));
vi.mock("../domains/pricingAcceptanceWriter.js", () => ({
  PricingAcceptanceError: class PricingAcceptanceError extends Error {
    constructor(
      readonly code: "conflict" | "storage" | "unexpected",
      _cause?: unknown,
    ) {
      super("Pricing acceptance failed");
    }
  },
  writePricingAcceptance: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: true,
  adultAgeThreshold: 12,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkInUntil: "00:00",
  checkOutTime: "11:00",
  checkOutFrom: "06:00",
};
const evidence = {
  quote: {
    quoteId: id,
    evidence: {
      issuedAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-09-14T00:05:00.000Z",
      revisions: { finance: "PRIVATE-FINANCE" },
    },
  },
  quoteEvidenceId: "sha256:" + "a".repeat(64),
  guestPolicyEvidenceId: "sha256:" + "b".repeat(64),
  checkedAt: "2026-09-14T00:01:00.000Z",
  disclosure: { propertyTimeZone: "Europe/Berlin", choices },
  policy: { sourceRevision: "PRIVATE-OWNER" },
  disclosureJson: "PRIVATE-DISCLOSURE",
};
let app: FastifyInstance;
const query = vi.fn(async (_sql: string) => ({ rows: [] })),
  release = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(evidence as never);
});
afterEach(async () => {
  await app?.close();
});
async function mount(available = true, acceptance = false, affiliateBinding = false) {
  app = Fastify({ logger: false });
  const checkoutAdapter = available
    ? createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: "postgresql://unused",
        inventoryReservationPort: {} as never,
        replacementPricingAcceptanceAllowedSlugs: acceptance ? ["hotel"] : [],
        pool: { query, connect: async () => ({ query, release }), end: async () => {} } as never,
      })
    : unusedBookingWebCheckoutAdapter;
  await app.register(registerBookingWebPublicRoutes, {
    prefix: "/api/booking-web",
    checkoutAdapter,
    profileRepository: {} as never,
    affiliateContextBindingEnabled: affiliateBinding,
  });
}
const get = (quoteId = id) =>
  app.inject({
    method: "GET",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${quoteId}/guest-disclosure`,
  });
it("returns only public disclosure through the real route/adapter and disables caching/indexing", async () => {
  await mount();
  const response = await get();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-robots-tag"]).toBe("noindex");
  expect(response.json()).toEqual({
    version: "public-quote-guest-disclosure.v1",
    quoteId: id,
    quoteEvidenceId: evidence.quoteEvidenceId,
    guestPolicyEvidenceId: evidence.guestPolicyEvidenceId,
    issuedAt: evidence.quote.evidence.issuedAt,
    expiresAt: evidence.quote.evidence.expiresAt,
    checkedAt: evidence.checkedAt,
    propertyTimeZone: "Europe/Berlin",
    choices,
  });
  expect(response.body).not.toContain("PRIVATE");
  expect(lockCurrentQuoteGuestDisclosure).toHaveBeenCalledWith({ query, release }, "hotel", id);
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK",
  ]);
  expect(release).toHaveBeenCalledOnce();
});
it("fails closed for unavailable owners and invalid quote IDs", async () => {
  await mount();
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockResolvedValue(null);
  for (const quoteId of [id, "invalid-id"]) {
    const response = await get(quoteId);
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("choices");
  }
  expect(lockCurrentQuoteGuestDisclosure).toHaveBeenCalledOnce();
});
it("hides owner failure details in a generic 503 and releases the transaction", async () => {
  await mount();
  vi.mocked(lockCurrentQuoteGuestDisclosure).mockRejectedValue(new Error("PRIVATE-OWNER-SQL"));
  const response = await get();
  expect(response.statusCode).toBe(503);
  expect(response.body).not.toContain("PRIVATE");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(release).toHaveBeenCalledOnce();
});
it("returns unavailable when the checkout adapter has no disclosure capability", async () => {
  await mount(false);
  expect((await get()).statusCode).toBe(404);
  expect(lockCurrentQuoteGuestDisclosure).not.toHaveBeenCalled();
});
it("keeps quote acceptance disabled until explicitly enabled", async () => {
  await mount();
  const response = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: { "idempotency-key": "accept-1" },
    payload: { version: "booking-quote-acceptance.v1", requestId: "accept-1", quoteId: id },
  });
  expect(response.statusCode).toBe(404);
  expect(writePricingAcceptance).not.toHaveBeenCalled();
});
it("keeps quote acceptance disabled outside the explicit slug allowlist", async () => {
  await mount(true, true);
  const response = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/other-hotel/bookings/quotes/${id}/accept`,
    headers: { "idempotency-key": "accept-1" },
    payload: { version: "booking-quote-acceptance.v1", requestId: "accept-1", quoteId: id },
  });
  expect(response.statusCode).toBe(404);
  expect(writePricingAcceptance).not.toHaveBeenCalled();
});
it("binds the path and idempotency key before invoking enabled acceptance", async () => {
  vi.mocked(writePricingAcceptance).mockResolvedValue({
    kind: "accepted",
    bookingId: id,
    acceptanceId: "22222222-2222-4222-8222-222222222222",
  } as never);
  await mount(true, true);
  const payload = {
    version: "booking-quote-acceptance.v1",
    requestId: "accept-1",
    quoteId: id,
  };
  const accepted = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: { "idempotency-key": "accept-1" },
    payload,
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.headers["cache-control"]).toBe("no-store");
  expect(accepted.headers["x-robots-tag"]).toBe("noindex");
  expect(writePricingAcceptance).toHaveBeenCalledWith(expect.anything(), {
    slug: "hotel",
    command: payload,
  });
  for (const [quoteId, requestId] of [
    ["33333333-3333-4333-8333-333333333333", "accept-1"],
    [id, "other"],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
      headers: { "idempotency-key": "accept-1" },
      payload: { ...payload, quoteId, requestId },
    });
    expect(response.statusCode).toBe(400);
  }
  expect(writePricingAcceptance).toHaveBeenCalledOnce();
});

it("takes a valid affiliate handle only from the cookie and verifies it before the writer", async () => {
  const contextId = "33333333-3333-4333-8333-333333333333";
  const forged = "44444444-4444-4444-8444-444444444444";
  vi.mocked(readBookingAffiliateContextForQuote).mockResolvedValue(contextId);
  vi.mocked(writePricingAcceptance).mockResolvedValue({ kind: "accepted" } as never);
  await mount(true, true, true);
  const payload = {
    version: "booking-quote-acceptance.v1",
    requestId: "accept-affiliate",
    quoteId: id,
    affiliateContextId: forged,
  };
  const response = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: {
      "idempotency-key": "accept-affiliate",
      cookie: `__Host-vayada_affiliate_context=${contextId}`,
    },
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(readBookingAffiliateContextForQuote).toHaveBeenCalledWith(
    expect.anything(),
    "hotel",
    contextId,
  );
  expect(writePricingAcceptance).toHaveBeenCalledWith(
    expect.anything(),
    { slug: "hotel", command: payload },
    { affiliateContextId: contextId },
  );
});

it("keeps affiliate cookie binding off by default even when a cookie is supplied", async () => {
  vi.mocked(writePricingAcceptance).mockResolvedValue({ kind: "accepted" } as never);
  await mount(true, true);
  const payload = { version: "booking-quote-acceptance.v1", requestId: "accept-1", quoteId: id };
  const response = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: {
      "idempotency-key": "accept-1",
      cookie: "__Host-vayada_affiliate_context=33333333-3333-4333-8333-333333333333",
    },
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(readBookingAffiliateContextForQuote).not.toHaveBeenCalled();
  expect(writePricingAcceptance).toHaveBeenCalledWith(expect.anything(), {
    slug: "hotel",
    command: payload,
  });
});

it("ignores duplicate, invalid, or unavailable affiliate cookies without blocking acceptance", async () => {
  vi.mocked(writePricingAcceptance).mockResolvedValue({ kind: "accepted" } as never);
  await mount(true, true, true);
  const contextId = "33333333-3333-4333-8333-333333333333";
  const payload = { version: "booking-quote-acceptance.v1", requestId: "accept-1", quoteId: id };
  for (const cookie of [
    `__Host-vayada_affiliate_context=${contextId}; __Host-vayada_affiliate_context=${contextId}`,
    "__Host-vayada_affiliate_context=not-a-uuid",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
      headers: { "idempotency-key": "accept-1", cookie },
      payload,
    });
    expect(response.statusCode).toBe(200);
  }
  expect(readBookingAffiliateContextForQuote).not.toHaveBeenCalled();
  expect(writePricingAcceptance).toHaveBeenCalledWith(expect.anything(), {
    slug: "hotel",
    command: payload,
  });
  vi.mocked(readBookingAffiliateContextForQuote).mockRejectedValue(
    new Error("storage unavailable"),
  );
  const fallback = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: {
      "idempotency-key": "accept-1",
      cookie: `__Host-vayada_affiliate_context=${contextId}`,
    },
    payload,
  });
  expect(fallback.statusCode).toBe(200);
  expect(writePricingAcceptance).toHaveBeenLastCalledWith(expect.anything(), {
    slug: "hotel",
    command: payload,
  });
});
it.each([
  ["conflict", 409],
  ["storage", 503],
  ["unexpected", 500],
] as const)("maps %s acceptance failures to %i", async (code, statusCode) => {
  vi.mocked(writePricingAcceptance).mockRejectedValue(new PricingAcceptanceError(code, null));
  await mount(true, true);
  const response = await app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/hotel/bookings/quotes/${id}/accept`,
    headers: { "idempotency-key": "accept-1" },
    payload: {
      version: "booking-quote-acceptance.v1",
      requestId: "accept-1",
      quoteId: id,
    },
  });
  expect(response.statusCode).toBe(statusCode);
  expect(response.body).not.toContain("Pricing acceptance failed");
});
