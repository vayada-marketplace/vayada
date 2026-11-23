import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import Fastify from "fastify";
import { it, expect, vi } from "vitest";
import { registerBookingHostActionRoutes } from "./routes/bookingHostActions.js";
const propertyId = "93000000-0000-4000-8000-000000000001",
  actorUserId = "93000000-0000-4000-8000-000000000003",
  organizationId = "93000000-0000-4000-8000-000000000004",
  evaluatedAt = "2026-09-05T00:00:00Z";
type Auth = {
  permissions?: PermissionKey[];
  links?: LinkedResource[];
  entitlements?: ProductEntitlement[];
  kind?: RequestContext["selectedOrganization"]["kind"];
};
it.each(
  ["preview", "apply", "card-refund-retry"].flatMap((endpoint) =>
    [
      "missing",
      "invalid",
      "permission",
      "update-only",
      "entitlement",
      "inactive",
      "resource",
      "allowed",
    ].map((mode) => ({ endpoint, mode })),
  ),
)("enforces $mode authorization on $endpoint", async ({ endpoint, mode }) => {
  const app = Fastify();
  const requestEmail = vi.fn(async () => ({ jobId: propertyId }));
  const auth: Auth =
    mode === "update-only"
      ? { permissions: ["pms.reservation.update"] }
      : mode === "permission"
        ? { permissions: [] }
        : mode === "entitlement"
          ? { entitlements: [] }
          : mode === "inactive"
            ? { entitlements: [entitlement("suspended")] }
            : mode === "resource"
              ? { links: [] }
              : {};
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (!["missing", "invalid"].includes(mode)) request.authContext = context(auth);
  });
  await app.register(registerBookingHostActionRoutes, {
    actions: {
      preview: requestEmail as never,
      apply: requestEmail as never,
      retryCardRefund: requestEmail as never,
      close: async () => {},
      findAction: async () => "cancel",
    },
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "all",
        roleKey: "operator",
        accessOrigin: "agency",
        assignedPropertyIds: [],
      }),
    },
  });
  const response = await app.inject({
    method: "POST",
    url: `/properties/${propertyId}/reservations/${propertyId}/host-actions/${endpoint}`,
    payload:
      endpoint === "preview"
        ? { action: "cancel", reason: "Internal reason" }
        : endpoint === "apply"
          ? { previewId: propertyId, idempotencyKey: "key" }
          : { idempotencyKey: "key" },
  });
  expect(response.statusCode).toBe(
    mode === "allowed" ? 200 : ["missing", "invalid"].includes(mode) ? 401 : 403,
  );
  expect(requestEmail).toHaveBeenCalledTimes(mode === "allowed" ? 1 : 0);
  await app.close();
});
// VAY-2099: staff who can accept a request but not cancel bookings may reject a request: the route
// lets them through and asks the action to check the booking (requestsOnly).
it.each([
  ["update-only", ["pms.reservation.update"] as PermissionKey[], true],
  [
    "update and cancel",
    ["pms.reservation.update", "pms.reservation.cancel"] as PermissionKey[],
    false,
  ],
])("lets %s staff reject a request through the right check", async (_who, permissions, only) => {
  const app = Fastify();
  const preview = vi.fn(async () => ({ previewId: propertyId }));
  const apply = vi.fn(async () => ({ bookingId: propertyId, lifecycleStatus: "declined" }));
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = context({ permissions });
  });
  await app.register(registerBookingHostActionRoutes, {
    actions: {
      preview: preview as never,
      apply: apply as never,
      retryCardRefund: vi.fn() as never,
      close: async () => {},
      findAction: async () => "reject",
    },
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "all",
        roleKey: "front_desk",
        accessOrigin: "agency",
        assignedPropertyIds: [],
      }),
    },
  });
  const base = `/properties/${propertyId}/reservations/${propertyId}/host-actions`;
  const previewed = await app.inject({
    method: "POST",
    url: `${base}/preview`,
    payload: { action: "reject", reason: "Fully booked" },
  });
  expect(previewed.statusCode).toBe(200);
  const applied = await app.inject({
    method: "POST",
    url: `${base}/apply`,
    payload: { previewId: propertyId, idempotencyKey: "key" },
  });
  expect(applied.statusCode).toBe(200);
  const scope = { propertyId, bookingId: propertyId, actorUserId };
  const action = { action: "reject", reason: "Fully booked" };
  if (only) {
    expect(preview).toHaveBeenCalledWith(scope, action, { requestsOnly: true });
    expect(apply).toHaveBeenCalledWith(scope, propertyId, "key", { requestsOnly: true });
  } else {
    expect(preview).toHaveBeenCalledWith(scope, action);
    expect(preview.mock.calls[0]).toHaveLength(2);
    expect(apply.mock.calls[0]).toHaveLength(3);
  }
  // Cancelling still needs the cancel permission.
  const cancelled = await app.inject({
    method: "POST",
    url: `${base}/preview`,
    payload: { action: "cancel", reason: "Guest asked" },
  });
  expect(cancelled.statusCode).toBe(only ? 403 : 200);
  await app.close();
});

function context(auth: Auth): RequestContext {
  return {
    actor: {
      internalUserId: actorUserId,
      providerIdentity: { provider: "workos", providerUserId: "user-1" },
      email: "operator@example.test",
      status: "active",
    },
    selectedOrganization: {
      organizationId,
      kind: auth.kind ?? "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "membership-1",
      status: "active",
      roleKey: "operator",
      workosRoleSlugs: [],
      permissions: auth.permissions ?? ["pms.reservation.update", "pms.reservation.cancel"],
    },
    linkedResources: auth.links ?? links("operator"),
    entitlements: auth.entitlements ?? [entitlement()],
    locale: "en",
    currency: "EUR",
    audit: {
      requestId: "request-1",
      correlationId: "correlation-1",
      source: "api",
      receivedAt: evaluatedAt,
    },
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status,
    resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
  };
}

function links(relationship: LinkedResource["relationship"]): LinkedResource[] {
  return [
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship,
      status: "active",
    },
    {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      relationship,
      status: "active",
    },
  ];
}
