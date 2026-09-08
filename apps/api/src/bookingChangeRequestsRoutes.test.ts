import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";
import { registerBookingChangeRequestRoutes } from "./routes/bookingChangeRequests.js";
it.each(
  ["read", "accept", "decline"].flatMap((action) =>
    ["missing", "permission", "entitlement", "inactive", "resource", "read-only", "allowed"].map(
      (mode) => ({
        action,
        mode,
      }),
    ),
  ),
)("protects $action against $mode", async ({ action, mode }) => {
  const app = Fastify();
  const context = structuredClone(requestContextFixtureCases[0]!.context);
  if (mode === "read-only") context.membership.permissions = ["booking.reservation.read"];
  if (mode === "permission") context.membership.permissions = [];
  if (mode === "entitlement") context.entitlements = [];
  if (mode === "inactive")
    context.entitlements = context.entitlements.map((e) => ({
      ...e,
      status: "suspended" as const,
    }));
  if (mode === "resource") context.linkedResources = [];
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (mode !== "missing") request.authContext = context;
  });
  const handler = vi.fn(async () => ({
    providerRequest: {
      state: "pending",
      allowedActions: ["accept", "decline"],
      refreshAction: "accept",
    },
  }));
  await registerBookingChangeRequestRoutes(app, {
    findLatestChangeRequest: handler,
    acceptChangeRequest: handler,
    declineChangeRequest: handler,
  });
  const response = await app.inject({
    method: action === "read" ? "GET" : "POST",
    url: `/hotels/booking_hotel_alpenrose/reservations/booking/change-request${action === "read" ? "" : `/request/${action}`}`,
  });
  expect(response.statusCode).toBe(
    mode === "allowed" || (mode === "read-only" && action === "read")
      ? 200
      : mode === "missing"
        ? 401
        : 403,
  );
  expect(handler).toHaveBeenCalledTimes(
    mode === "allowed" || (mode === "read-only" && action === "read") ? 1 : 0,
  );
  if (mode === "read-only" && action === "read")
    expect(response.json().providerRequest).toMatchObject({
      allowedActions: [],
      refreshAction: null,
    });
  if (mode === "allowed" && action === "read")
    expect(response.json().providerRequest.allowedActions).toEqual(["accept", "decline"]);
  await app.close();
});
