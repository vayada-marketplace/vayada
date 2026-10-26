import { pricingCurrencyScale } from "@vayada/domain-pms/replacement-pricing";
import type { FastifyPluginAsync } from "fastify";

import {
  createReplacementPricingFxReader,
  REPLACEMENT_FX_ATTRIBUTION,
} from "../domains/replacementPricingFx.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";
import { createHttpError } from "./bookingWebPublic.js";

type FxReader = Pick<ReturnType<typeof createReplacementPricingFxReader>, "read">;
type Rates = Record<string, number>;
type Entry = {
  until: number;
  rates: Promise<Rates>;
  good: Record<string, { at: number; rate: number }>;
};

export type BookingWebDisplayRates = {
  rates(base: string, targets: readonly string[]): Promise<Rates>;
};

const hour = 3_600_000;
const refreshAfter = 6 * hour;
const retryAfter = hour;
const keepLastGoodFor = 48 * hour;

/**
 * Display-only guest rates (VAY-2114). Its own FX reader and cache, never shared with pricing,
 * so guest traffic cannot drive provider calls: one refresh per base and currency set every
 * 6 h (1 h after a miss), single-flight, keeping each currency's last good rate for 48 h.
 */
export function createBookingWebDisplayRates(
  dependencies: { reader?: FxReader; now?: () => number } = {},
): BookingWebDisplayRates {
  const reader = dependencies.reader ?? createReplacementPricingFxReader();
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, Entry>();

  async function load(base: string, targets: readonly string[]): Promise<Rates> {
    const fromScale = pricingCurrencyScale(base);
    const read = await Promise.all(
      targets.map(async (to) => [to, await reader.read(base, to).catch(() => null)] as const),
    );
    const rates: Rates = {};
    for (const [to, rate] of read) {
      const toScale = pricingCurrencyScale(to);
      if (!rate || fromScale === null || toScale === null) continue;
      // Exact minor-unit ratio back to a major-unit rate; floating point is fine for display.
      const value =
        (Number(rate.numerator) * 10 ** (fromScale - toScale)) / Number(rate.denominator);
      if (Number.isFinite(value) && value > 0) rates[to] = value;
    }
    return rates;
  }

  return {
    rates(base, targets) {
      const unique = [...new Set(targets)].sort();
      const key = `${base}:${unique.join(",")}`;
      const started = now();
      const entry = cache.get(key);
      if (entry && started < entry.until) return entry.rates;
      const next: Entry = {
        until: started + retryAfter,
        good: { ...entry?.good },
        rates: Promise.resolve({}),
      };
      next.rates = load(base, unique).then((fresh) => {
        const at = now();
        for (const [code, rate] of Object.entries(fresh)) next.good[code] = { at, rate };
        next.until = at + (Object.keys(fresh).length === unique.length ? refreshAfter : retryAfter);
        return Object.fromEntries(
          Object.entries(next.good)
            .filter(([, kept]) => at - kept.at < keepLastGoodFor)
            .map(([code, kept]) => [code, kept.rate]),
        );
      });
      cache.set(key, next);
      return next.rates;
    },
  };
}

export const registerBookingWebExchangeRateRoutes: FastifyPluginAsync<{
  profileRepository: PublicHotelProfileRepository;
  displayRates: BookingWebDisplayRates;
}> = async (app, { profileRepository, displayRates }) => {
  // Only this hotel's display currencies against its own base: never an open raw-rate feed.
  app.get<{ Params: { slug: string } }>("/hotels/:slug/exchange-rates", async (request, reply) => {
    const profile = await profileRepository.findProfileBySlug(request.params.slug);
    if (!profile) throw createHttpError(404, "Booking Web hotel profile not found.");
    const base = profile.hotel.defaultCurrency;
    const targets = (profile.hotel.branding?.displayCurrencies ?? []).filter(
      (code) => code !== base,
    );
    const rates = targets.length ? await displayRates.rates(base, targets) : {};
    reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    reply.header("X-Robots-Tag", "noindex");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-exchange-rates-read");
    return { base, rates, attribution: REPLACEMENT_FX_ATTRIBUTION };
  });
};
