import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createReplacementPricingFxReader } from "../domains/replacementPricingFx.js";
import {
  createBookingWebDisplayRates,
  registerBookingWebExchangeRateRoutes,
  type BookingWebDisplayRates,
} from "./bookingWebExchangeRates.js";

const hour = 3_600_000;
const start = Date.parse("2026-10-10T12:00:00.000Z");
type Reader = Pick<ReturnType<typeof createReplacementPricingFxReader>, "read">;

// Minor-unit ratios, as the pricing FX reader returns them.
const ratios: Record<string, [string, string]> = {
  USD: ["11", "10"], // 1 EUR = 1.10 USD
  JPY: ["8", "5"], // 100 cents = 160 yen
  IDR: ["17500", "1"], // ISO scale 2 on both sides
};
function fakeReader(missing: string[] = []) {
  return {
    read: vi.fn<Reader["read"]>(async (from, to) => {
      const ratio = ratios[to];
      if (!ratio || missing.includes(to)) return null;
      return {
        id: `exchange-rate-api:${to}`,
        from,
        to,
        numerator: ratio[0],
        denominator: ratio[1],
        observedAt: new Date(start).toISOString(),
        expiresAt: new Date(start + 24 * hour).toISOString(),
      };
    }),
  };
}

describe("booking web display rates", () => {
  it("turns exact minor-unit ratios into major-unit display rates", async () => {
    const rates = createBookingWebDisplayRates({ reader: fakeReader(), now: () => start });

    expect(await rates.rates("EUR", ["USD", "JPY", "IDR"])).toEqual({
      USD: 1.1,
      JPY: 160,
      IDR: 17500,
    });
  });

  it("matches the provider's published rates through the real pricing reader", async () => {
    const body = JSON.stringify({
      result: "success",
      provider: "https://www.exchangerate-api.com",
      base_code: "EUR",
      time_last_update_unix: (start - hour) / 1000,
      time_next_update_unix: (start + 23 * hour) / 1000,
      time_eol_unix: 0,
      rates: { EUR: 1, USD: 1.0832, JPY: 161.5 },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
    const reader = createReplacementPricingFxReader({ fetch, now: () => start });
    const rates = createBookingWebDisplayRates({ reader, now: () => start });

    expect(await rates.rates("EUR", ["USD", "JPY"])).toEqual({ USD: 1.0832, JPY: 161.5 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("calls the provider once per base and currency set however many guests ask", async () => {
    let time = start;
    const reader = fakeReader();
    const rates = createBookingWebDisplayRates({ reader, now: () => time });

    await Promise.all(Array.from({ length: 50 }, () => rates.rates("EUR", ["USD", "JPY"])));
    time += 6 * hour - 1;
    await rates.rates("EUR", ["JPY", "USD", "USD"]);
    expect(reader.read).toHaveBeenCalledTimes(2);

    time += 1;
    await rates.rates("EUR", ["USD", "JPY"]);
    expect(reader.read).toHaveBeenCalledTimes(4);
  });

  it("leaves out a currency without a rate and retries it after an hour", async () => {
    let time = start;
    const reader = fakeReader(["JPY"]);
    const rates = createBookingWebDisplayRates({ reader, now: () => time });

    expect(await rates.rates("EUR", ["USD", "JPY"])).toEqual({ USD: 1.1 });
    time += hour;
    await rates.rates("EUR", ["USD", "JPY"]);
    expect(reader.read).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good rates for up to 48 hours while the provider is down", async () => {
    let time = start;
    let down = false;
    const healthy = fakeReader();
    const reader = {
      read: vi.fn<Reader["read"]>((from, to) =>
        down ? Promise.resolve(null) : healthy.read(from, to),
      ),
    };
    const rates = createBookingWebDisplayRates({ reader, now: () => time });

    await rates.rates("EUR", ["USD"]);
    down = true;
    time += 6 * hour;
    expect(await rates.rates("EUR", ["USD"])).toEqual({ USD: 1.1 });
    time += 42 * hour - 1;
    expect(await rates.rates("EUR", ["USD"])).toEqual({ USD: 1.1 });
    time += hour;
    expect(await rates.rates("EUR", ["USD"])).toEqual({});
  });

  it("keeps a currency's last good rate when a later refresh misses only that one", async () => {
    let time = start;
    const missing: string[] = [];
    const healthy = fakeReader();
    const reader = {
      read: vi.fn<Reader["read"]>((from, to) =>
        missing.includes(to) ? Promise.resolve(null) : healthy.read(from, to),
      ),
    };
    const rates = createBookingWebDisplayRates({ reader, now: () => time });

    await rates.rates("EUR", ["USD", "JPY"]);
    missing.push("JPY");
    time += 6 * hour;
    expect(await rates.rates("EUR", ["USD", "JPY"])).toEqual({ USD: 1.1, JPY: 160 });
  });

  it("answers no rates when the reader fails outright", async () => {
    const reader = { read: vi.fn<Reader["read"]>().mockRejectedValue(new Error("offline")) };
    const rates = createBookingWebDisplayRates({ reader, now: () => start });

    expect(await rates.rates("EUR", ["USD"])).toEqual({});
  });
});

describe("GET /api/booking-web/hotels/:slug/exchange-rates", () => {
  function profile(displayCurrencies?: string[]): PublicBookabilityProfileProjection {
    const base = PUBLIC_BOOKABILITY_FIXTURES[0]!.profile;
    return {
      ...base,
      hotel: {
        ...base.hotel,
        branding: {
          heroImage: null,
          heroHeading: null,
          heroSubtext: null,
          primaryColor: null,
          fontPairing: null,
          ...(displayCurrencies ? { displayCurrencies } : {}),
        },
      },
    };
  }

  async function harness(found: PublicBookabilityProfileProjection | null) {
    const displayRates: BookingWebDisplayRates = {
      rates: vi.fn(async (_base: string, targets: readonly string[]) =>
        Object.fromEntries(targets.map((code) => [code, 1.5])),
      ),
    };
    const app = Fastify({ logger: false });
    await app.register(registerBookingWebExchangeRateRoutes, {
      prefix: "/api/booking-web",
      profileRepository: { findProfileBySlug: async () => found },
      displayRates,
    });
    return { app, displayRates };
  }

  it("serves only the hotel's display currencies against its own base, with attribution", async () => {
    const { app, displayRates } = await harness(profile(["EUR", "USD", "GBP"]));

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/exchange-rates?base=JPY",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      base: "EUR",
      rates: { USD: 1.5, GBP: 1.5 },
      attribution: { label: "Rates By Exchange Rate API", url: "https://www.exchangerate-api.com" },
    });
    expect(displayRates.rates).toHaveBeenCalledWith("EUR", ["USD", "GBP"]);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=300, stale-while-revalidate=600",
    );
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    await app.close();
  });

  it("asks for no rates when the hotel offers only its pricing currency", async () => {
    const { app, displayRates } = await harness(profile());

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/exchange-rates",
    });

    expect(response.json()).toMatchObject({ base: "EUR", rates: {} });
    expect(displayRates.rates).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 for a hotel without a public profile", async () => {
    const { app, displayRates } = await harness(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/missing/exchange-rates",
    });

    expect(response.statusCode).toBe(404);
    expect(displayRates.rates).not.toHaveBeenCalled();
    await app.close();
  });
});
