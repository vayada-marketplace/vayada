import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";
import { registerPmsBookingChangeRequestRoutes } from "./routes/pmsBookingChangeRequests.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
// VAY-2360: guests' extras requests share the change requests' routes and rules.
it.each(
  ["change-request", "extras-request"]
    .flatMap((kind) => ["read", "accept", "decline"].map((action) => ({ kind, action })))
    .flatMap(({ kind, action }) =>
      [
        "allowed",
        "read-only",
        "missing",
        "permission",
        "entitlement",
        "suspended",
        "resource",
        "unassigned",
        "origin",
        "legacy-only",
      ].map((mode) => ({ kind, action, mode })),
    ),
)("PMS $kind $action with $mode", async ({ kind, action, mode }) => {
  const app = Fastify();
  const context = structuredClone(requestContextFixtureCases[0]!.context);
  context.membership.roleKey = "front_desk";
  context.membership.permissions =
    mode === "legacy-only"
      ? ["booking.reservation.read", "pms.booking.update"]
      : mode === "permission"
        ? []
        : mode === "read-only"
          ? ["pms.reservation.read"]
          : ["pms.reservation.read", "pms.reservation.update"];
  context.entitlements =
    mode === "entitlement"
      ? []
      : [
          {
            product: "pms",
            key: "property-management",
            status: mode === "suspended" ? "suspended" : "active",
          },
        ];
  context.linkedResources =
    mode === "resource"
      ? []
      : [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: propertyId,
            relationship: "front_desk",
            status: "active",
          },
          {
            product: "pms",
            resourceType: "pms_property",
            resourceId: propertyId,
            relationship: "front_desk",
            status: "active",
          },
        ];
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (mode !== "missing") request.authContext = context;
  });
  const handler = vi.fn(async () => ({
    providerRequest: { allowedActions: ["accept", "decline"], refreshAction: "accept" },
  }));
  app.register(registerPmsBookingChangeRequestRoutes, {
    prefix: "/api/pms",
    repository: {
      findLatestChangeRequest: handler,
      acceptChangeRequest: handler,
      declineChangeRequest: handler,
      findExtrasRequests: vi.fn(async () => [handler()]),
      decideExtrasRequest: handler,
    },
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "assigned",
        roleKey: "front_desk",
        accessOrigin: "agency",
        assignedPropertyIds: mode === "unassigned" ? [] : [propertyId],
      }),
    },
    allowedOrigins: ["https://pms.test"],
  });
  const response = await app.inject({
    method: action === "read" ? "GET" : "POST",
    url: `/api/pms/properties/${propertyId}/reservations/booking/${kind}${action === "read" ? "" : `/request/${action}`}`,
    headers: { origin: mode === "origin" ? "https://wrong.test" : "https://pms.test" },
  });
  const allowed = mode === "allowed" || (mode === "read-only" && action === "read");
  expect(response.statusCode, response.body).toBe(allowed ? 200 : mode === "missing" ? 401 : 403);
  expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
  if (mode === "read-only" && action === "read" && kind === "change-request")
    expect(response.json().providerRequest).toEqual({ allowedActions: [], refreshAction: null });
  if (allowed && kind === "extras-request" && action !== "read")
    expect(handler).toHaveBeenCalledWith(
      propertyId,
      "booking",
      "request",
      action,
      null,
      expect.objectContaining({ actorUserId: expect.any(String) }),
    );
  if (allowed) expect(response.headers["access-control-allow-origin"]).toBe("https://pms.test");
  await app.close();
});
