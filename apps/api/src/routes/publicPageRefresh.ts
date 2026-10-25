import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { BookingPublicationRefreshPort } from "../domains/bookingPublicationProductionRuntime.js";

type PublicPageRefresh = (propertyId: string, request: FastifyRequest) => Promise<void>;

/** After a successful save on one of `routes` (e.g. "PUT /properties/:propertyId/profile"),
 * refresh what guests see on the booking page (VAY-2129). Runs once the reply is sent; a failure
 * is only logged, and the next save or inventory projection refreshes the page again. */
export function refreshPublicPageAfterSaves(
  app: FastifyInstance,
  routes: readonly string[],
  refresh: PublicPageRefresh | undefined,
): void {
  if (!refresh) return;
  app.addHook("onResponse", async (request, reply) => {
    const propertyId = (request.params as { propertyId?: unknown } | undefined)?.propertyId;
    const url = request.routeOptions.url ?? "";
    const saved = routes.some((route) => {
      const [method, path] = route.split(" ");
      return request.method === method && url.endsWith(path!);
    });
    if (!saved || reply.statusCode >= 300 || typeof propertyId !== "string") return;
    await refresh(propertyId, request).catch((error: unknown) =>
      request.log.warn({ err: error, propertyId }, "Booking page refresh after a save failed"),
    );
  });
}

/** Where the public site serves setup publications (production), a save republishes a live page
 * as the hotel user who saved, like Booking settings saves; the target-mode refresher only runs
 * without one (VAY-2344: hotel-detail saves never reached a live page in production). */
export function livePublicPageRefresh(options: {
  bookingPublicationRefresh?: BookingPublicationRefreshPort;
  refreshPublicPage?: (propertyId: string) => Promise<void>;
}): PublicPageRefresh | undefined {
  const { bookingPublicationRefresh, refreshPublicPage } = options;
  if (!bookingPublicationRefresh) return refreshPublicPage;
  return async (propertyId, request) => {
    const context = requireAuthContext(request);
    await bookingPublicationRefresh.refresh({
      organizationId: context.selectedOrganization.organizationId,
      propertyId,
      actorUserId: context.actor.internalUserId,
      idempotencyKey: context.audit.requestId,
      audit: context.audit,
      onlyIfLive: true,
    });
  };
}
