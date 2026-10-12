import type { FastifyInstance } from "fastify";

/** After a successful save on one of `routes` (e.g. "PUT /properties/:propertyId/profile"),
 * refresh what guests see on the booking page (VAY-2129). Runs once the reply is sent; a failure
 * is only logged, and the next save or inventory projection refreshes the page again. */
export function refreshPublicPageAfterSaves(
  app: FastifyInstance,
  routes: readonly string[],
  refresh: ((propertyId: string) => Promise<void>) | undefined,
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
    await refresh(propertyId).catch((error: unknown) =>
      request.log.warn({ err: error, propertyId }, "Booking page refresh after a save failed"),
    );
  });
}
