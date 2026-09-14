import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lockCurrentQuoteGuestDisclosure } from "../domains/currentQuoteGuestDisclosure.js";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
} from "./bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";
vi.mock("../domains/currentQuoteGuestDisclosure.js", () => ({
  lockCurrentQuoteGuestDisclosure: vi.fn(),
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
async function mount(available = true) {
  app = Fastify({ logger: false });
  const checkoutAdapter = available
    ? createTargetBookingWebCheckoutAdapter({
        connectionString: "postgresql://unused",
        inventoryReservationPort: {} as never,
        pool: { query, connect: async () => ({ query, release }), end: async () => {} } as never,
      })
    : unusedBookingWebCheckoutAdapter;
  await app.register(registerBookingWebPublicRoutes, {
    prefix: "/api/booking-web",
    checkoutAdapter,
    profileRepository: {} as never,
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
