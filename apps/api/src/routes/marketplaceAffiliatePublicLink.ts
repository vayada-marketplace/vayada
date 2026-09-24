import type { FastifyInstance } from "fastify";
import { parseMarketplaceAffiliateLink } from "@vayada/domain-marketplace";
import { affiliateTrafficSource } from "../domains/marketplaceAffiliateClickOccurrence.js";

export type MarketplaceAffiliatePublicLinkVisit = (input: {
  publicToken: string;
  campaignLabel: string | null;
  source: ReturnType<typeof affiliateTrafficSource>;
}) => Promise<{ status: "unavailable" } | { status: "ready"; redirectUrl: string }>;
export type MarketplaceAffiliatePublicLinkQuota = (input: {
  publicToken: string;
  requesterIp: string;
}) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;

export type MarketplaceAffiliatePublicLinkRoutesOptions = {
  visit: MarketplaceAffiliatePublicLinkVisit;
  consumeQuota: MarketplaceAffiliatePublicLinkQuota;
};

/** Mounted only when the runtime supplies both guarded visit capture and a production quota. */
export async function registerMarketplaceAffiliatePublicLinkRoute(
  app: FastifyInstance,
  options: MarketplaceAffiliatePublicLinkRoutesOptions,
) {
  app.get<{ Params: { publicToken: string }; Querystring: { campaign?: string } }>(
    "/r/:publicToken",
    { exposeHeadRoute: false },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
      const parsed = parseMarketplaceAffiliateLink(
        request.params.publicToken,
        request.query.campaign,
      );
      if (!parsed.ok) return reply.code(404).send({ code: "not_found" });

      const quota = await options.consumeQuota({
        publicToken: parsed.publicToken,
        requesterIp: request.ip,
      });
      if (!quota.allowed) {
        if (quota.retryAfterSeconds && Number.isSafeInteger(quota.retryAfterSeconds))
          reply.header("Retry-After", String(quota.retryAfterSeconds));
        return reply.code(429).send({ code: "rate_limited" });
      }

      const result = await options.visit({
        publicToken: parsed.publicToken,
        campaignLabel: parsed.campaignLabel,
        source: affiliateTrafficSource(request.headers.referer),
      });
      if (result.status !== "ready") return reply.code(404).send({ code: "not_found" });
      // The route only accepts the native booking arrival URL shape. The visit
      // implementation must also obtain fresh, transaction-bound safety evidence.
      if (
        !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.next-booking\.vayada\.com\/\?vref=vc_[A-Za-z0-9_-]{22}$/.test(
          result.redirectUrl,
        )
      )
        throw new Error("Invalid affiliate arrival redirect");
      return reply.code(302).header("Location", result.redirectUrl).send();
    },
  );
}
