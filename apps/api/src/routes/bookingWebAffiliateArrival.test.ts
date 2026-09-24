import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import Fastify from "fastify";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { admitAffiliateArrivalForCurrentHost } from "../domains/bookingAffiliateArrivalHost.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";
import {
  admitBookingWebAffiliateArrival,
  registerBookingWebPublicRoutes,
} from "./bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./bookingWebPublic.fixtures.js";

vi.mock("../domains/bookingAffiliateArrivalHost.js", () => ({
  admitAffiliateArrivalForCurrentHost: vi.fn(),
}));

const base = PUBLIC_BOOKABILITY_FIXTURES[0]!.profile;
const pool = {} as pg.Pool;
const referenceToken = "vc_abcdefghijklmnopqrstuv";

function repository(profile: PublicBookabilityProfileProjection): PublicHotelProfileRepository {
  return {
    findProfileBySlug: vi.fn().mockResolvedValue(profile),
    findProfileByCustomDomain: vi.fn().mockResolvedValue(profile),
  };
}

describe("native affiliate arrival host boundary", () => {
  it("delegates the supplied final host to the transactional host boundary", async () => {
    vi.mocked(admitAffiliateArrivalForCurrentHost).mockResolvedValue({
      status: "admitted",
      contextId: "dd29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      contextCreated: true,
      clickId: "ee29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      historyPosition: "1",
      replayed: false,
    });
    const input = {
      host: "HOTEL-ALPENROSE.next-booking.vayada.com",
      referenceToken,
    };
    const result = await admitBookingWebAffiliateArrival(pool, input);
    expect(result.status).toBe("admitted");
    expect(admitAffiliateArrivalForCurrentHost).toHaveBeenCalledWith(pool, input);
  });
});

describe("guarded Booking API arrival transport", () => {
  const url = "/api/booking-web/affiliate/arrivals";
  const body = {
    host: "hotel-alpenrose.next-booking.vayada.com",
    referenceToken,
  };

  async function mount(enabled: boolean) {
    const app = Fastify({ logger: false });
    await app.register(registerBookingWebPublicRoutes, {
      prefix: "/api/booking-web",
      checkoutAdapter: unusedBookingWebCheckoutAdapter,
      profileRepository: repository({
        ...base,
        hotel: {
          ...base.hotel,
          bookingBaseUrl: "https://hotel-alpenrose.next-booking.vayada.com",
        },
      }),
      ...(enabled ? { affiliateArrival: { pool, internalToken: "test-internal-token" } } : {}),
    });
    return app;
  }

  it("is absent unless explicitly mounted and rejects missing or wrong internal tokens", async () => {
    const disabled = await mount(false);
    expect((await disabled.inject({ method: "POST", url, payload: body })).statusCode).toBe(404);
    await disabled.close();
    const app = await mount(true);
    vi.mocked(admitAffiliateArrivalForCurrentHost).mockClear();
    for (const headers of [{}, { "x-vayada-affiliate-arrival-token": "wrong" }]) {
      expect((await app.inject({ method: "POST", url, payload: body, headers })).statusCode).toBe(
        404,
      );
    }
    expect(admitAffiliateArrivalForCurrentHost).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns only a context handle after a valid admission", async () => {
    const app = await mount(true);
    const contextId = "dd29a9d9-9ca4-4931-9ef5-4d41e9a9cc41";
    vi.mocked(admitAffiliateArrivalForCurrentHost).mockResolvedValue({
      status: "admitted",
      contextId,
      contextCreated: true,
      clickId: "ee29a9d9-9ca4-4931-9ef5-4d41e9a9cc41",
      historyPosition: "1",
      replayed: false,
    });
    const response = await app.inject({
      method: "POST",
      url,
      payload: body,
      headers: { "x-vayada-affiliate-arrival-token": "test-internal-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ status: "admitted", contextId });
    expect(response.body).not.toContain("clickId");
    await app.close();
  });
});
