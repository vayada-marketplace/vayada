import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  registerBookingWebPublicRoutes,
  type BookingWebCheckoutAdapter,
} from "./bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";

const contextId = "aa29a9d9-9ca4-4931-9ef5-4d41e9a9cc41";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function create(cookie: string | undefined, enabled: boolean) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const createBooking = vi.fn<BookingWebCheckoutAdapter["createBooking"]>(async () => ({
    bookingReference: "VAY-TEST",
  }));
  await app.register(registerBookingWebPublicRoutes, {
    prefix: "/api/booking-web",
    checkoutAdapter: { ...unusedBookingWebCheckoutAdapter, createBooking },
    profileRepository: {} as never,
    affiliateContextBindingEnabled: enabled,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/booking-web/hotels/hotel/bookings",
    headers: cookie ? { cookie } : {},
    payload: { affiliateContextId: "guest-forgery" },
  });
  expect(response.statusCode).toBe(200);
  return createBooking.mock.calls[0];
}

it("passes only the server-read cookie to original booking creation behind the gate", async () => {
  const call = await create(`__Host-vayada_affiliate_context=${contextId}`, true);
  expect(call?.[3]).toBe(contextId);
  expect(call?.[1]).toEqual({ affiliateContextId: "guest-forgery" });
});

it("ignores a cookie while disabled and rejects duplicate or malformed cookies", async () => {
  expect(
    (await create(`__Host-vayada_affiliate_context=${contextId}`, false))?.[3],
  ).toBeUndefined();
  for (const cookie of [
    `__Host-vayada_affiliate_context=${contextId}; __Host-vayada_affiliate_context=${contextId}`,
    "__Host-vayada_affiliate_context=not-a-uuid",
  ])
    expect((await create(cookie, true))?.[3]).toBeUndefined();
});
