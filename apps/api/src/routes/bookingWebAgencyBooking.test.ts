import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPublicAccountBookingPage } from "../domains/accountBookingPages.js";
import { writePricingAcceptance } from "../domains/pricingAcceptanceWriter.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
} from "./bookingWebPublic.js";

vi.mock("../domains/pricingAcceptanceWriter.js", () => ({
  PricingAcceptanceError: class PricingAcceptanceError extends Error {},
  writePricingAcceptance: vi.fn(),
}));
vi.mock("../domains/accountBookingPages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domains/accountBookingPages.js")>()),
  readPublicAccountBookingPage: vi.fn(),
}));

// VAY-2462: a booking made on an agency page names it in X-Vayada-Agency-Page, outside the command.
// The route reads that live page's stays (kept 30 s) before the booking, and the writer records the
// page only if it shows this stay.
const id = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const payload = { version: "booking-quote-acceptance.v1", requestId: "accept-1", quoteId: id };
const warn = vi.fn();
const logger = {
  level: "info",
  fatal: vi.fn(),
  error: vi.fn(),
  warn,
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  child: () => logger,
};
let app: FastifyInstance;
const query = vi.fn(async () => ({ rows: [] }));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(writePricingAcceptance).mockResolvedValue({
    kind: "accepted",
    bookingId: id,
  } as never);
  app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
  });
  await app.register(registerBookingWebPublicRoutes, {
    prefix: "/api/booking-web",
    checkoutAdapter: createTargetBookingWebCheckoutAdapter({
      externalChanges: externalBookingChanges,
      connectionString: "postgresql://unused",
      inventoryReservationPort: {} as never,
      replacementPricingAcceptanceEnabled: true,
      pool: { query, connect: async () => ({ query, release() {} }), end: async () => {} } as never,
    }),
    profileRepository: {} as never,
  });
});
afterEach(async () => {
  await app.close();
});

const accept = (agencyPage?: string) =>
  app.inject({
    method: "POST",
    url: `/api/booking-web/hotels/escape-villa/bookings/quotes/${id}/accept`,
    headers: {
      "idempotency-key": "accept-1",
      ...(agencyPage === undefined ? {} : { "x-vayada-agency-page": agencyPage }),
    },
    payload,
  });
const page = (...propertyIds: string[]) =>
  ({ stays: propertyIds.map((propertyId) => ({ propertyId })) }) as never;

it("hands the writer the live page's stays for a booking made on it", async () => {
  vi.mocked(readPublicAccountBookingPage).mockResolvedValue(page("escape", "mertha"));
  expect((await accept("the-travel-ubud")).statusCode).toBe(200);
  expect(readPublicAccountBookingPage).toHaveBeenCalledWith(expect.anything(), "the-travel-ubud");
  expect(vi.mocked(writePricingAcceptance).mock.calls[0]![1]).toEqual({
    slug: "escape-villa",
    command: payload,
    agencyPage: { slug: "the-travel-ubud", propertyIds: ["escape", "mertha"] },
  });
  // The page is read once for a while, as for guests' browsing.
  await accept("the-travel-ubud");
  expect(readPublicAccountBookingPage).toHaveBeenCalledTimes(1);
});

it("books without the page when no live page has that address, or its read fails", async () => {
  vi.mocked(readPublicAccountBookingPage).mockResolvedValueOnce(null);
  expect((await accept("no-such-agency")).statusCode).toBe(200);
  vi.mocked(readPublicAccountBookingPage).mockRejectedValueOnce(new Error("pool busy"));
  expect((await accept("the-travel-ubud")).statusCode).toBe(200);
  for (const [, input] of vi.mocked(writePricingAcceptance).mock.calls)
    expect(input).toEqual({ slug: "escape-villa", command: payload, agencyPage: null });
  expect(warn).toHaveBeenCalledWith(
    { err: expect.any(Error) },
    "Agency page read for a booking failed",
  );
});

it("reads no page for a hotel's own booking, or for a header that names no address", async () => {
  expect((await accept()).statusCode).toBe(200);
  await accept("Not An Address");
  await accept("");
  for (const [, input] of vi.mocked(writePricingAcceptance).mock.calls)
    expect(input).toEqual({ slug: "escape-villa", command: payload });
  expect(readPublicAccountBookingPage).not.toHaveBeenCalled();
});

it("lets a browser send the header across origins", async () => {
  const preflight = await app.inject({
    method: "OPTIONS",
    url: `/api/booking-web/hotels/escape-villa/bookings/quotes/${id}/accept`,
    headers: {
      origin: "https://the-travel-ubud.next-booking.vayada.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,idempotency-key,x-vayada-agency-page",
    },
  });
  expect(preflight.headers["access-control-allow-headers"]).toContain("x-vayada-agency-page");
});
