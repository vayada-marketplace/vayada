import { UnauthorizedError, requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import {
  createShortLinkRateLimit,
  resolveGoogleMapsShortLink,
  type ShortLinkRateLimit,
  type ShortLinkResolution,
} from "../domains/googleMapsShortLinks.js";

/**
 * VAY-2444: POST /api/maps-links/resolve { url } → the long Google Maps link a maps.app.goo.gl share link opens,
 * for the PMS room editor and onboarding's "Where it is". Signed-in members of an active hotel account only;
 * 20 a minute per person. 200 { url } · 422 not_a_short_link · 404 unresolved · 503 unavailable · 429 rate_limited.
 */
export type GoogleMapsLinksRouteOptions = {
  resolve?: (url: unknown) => Promise<ShortLinkResolution>;
  rateLimit?: ShortLinkRateLimit;
};

export async function registerGoogleMapsLinksRoutes(
  app: FastifyInstance,
  options: GoogleMapsLinksRouteOptions,
) {
  const resolve = options.resolve ?? ((url: unknown) => resolveGoogleMapsShortLink(url));
  const rateLimit = options.rateLimit ?? createShortLinkRateLimit();

  app.post("/resolve", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    let actorId: string;
    try {
      const context = requireAuthContext(request);
      if (
        context.actor.status !== "active" ||
        context.selectedOrganization.kind !== "hotel_group" ||
        context.selectedOrganization.status !== "active" ||
        context.membership.status !== "active"
      )
        return reply.status(403).send({ code: "forbidden" });
      actorId = context.actor.internalUserId;
    } catch (error) {
      if (error instanceof UnauthorizedError)
        return reply.status(401).send({ code: "unauthenticated" });
      throw error;
    }
    const body = request.body as { url?: unknown } | null | undefined;
    const url = body && typeof body === "object" ? body.url : undefined;
    const allowed = rateLimit(actorId);
    if (!allowed.allowed) {
      reply.header("Retry-After", String(allowed.retryAfterSeconds));
      return reply.status(429).send({ code: "rate_limited" });
    }
    const result = await resolve(url);
    if (result.ok) return reply.send({ url: result.url });
    const status = { not_a_short_link: 422, unresolved: 404, unavailable: 503 }[result.code];
    return reply.status(status).send({ code: result.code });
  });
}
