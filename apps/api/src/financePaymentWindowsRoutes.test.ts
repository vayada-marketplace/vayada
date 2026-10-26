import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerFinancePaymentWindowsRoutes } from "./routes/financePaymentWindows.js";

const propertyId = "23480000-0000-4000-8000-000000000001";
const actorId = "23480000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const path = `/api/finance/properties/${propertyId}/payment-windows`;
const windows = {
  bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
  pay_at_property: { kind: "within", amount: 48, unit: "hours" },
} as const;

async function fixture(variant: string) {
  const repository = {
    read: vi.fn(async () => windows),
    replace: vi.fn(async (input: { windows: unknown }) => input.windows as typeof windows),
  };
  const app = Fastify();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (variant === "missing") return;
    request.authContext = {
      actor: { internalUserId: actorId, status: "active" },
      selectedOrganization: { organizationId: "org", kind: "hotel_group", status: "active" },
      membership: {
        roleKey: "hotel_owner",
        status: "active",
        permissions:
          variant === "permission"
            ? []
            : ["pms.finance.read", "pms.operations.manage", "booking.settings.manage"],
      },
      linkedResources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
        {
          ...resource,
          relationship: variant === "operator" ? "operator" : "owner",
          status: "active",
        },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active", resource }],
      audit: { requestId: "request", receivedAt: "2026-10-25T00:00:00Z" },
    } as RequestContext;
  });
  await app.register(registerFinancePaymentWindowsRoutes, {
    prefix: "/api",
    repository,
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "assigned",
        roleKey: "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: variant === "unassigned" ? [] : [propertyId],
      }),
    },
  });
  return { app, repository };
}

it.each(["missing", "permission", "operator", "unassigned", "allowed"])(
  "enforces %s authorization like the payment settings",
  async (variant) => {
    const { app, repository } = await fixture(variant);
    try {
      for (const method of ["GET", "PUT"] as const) {
        const response = await app.inject({
          method,
          url: path,
          ...(method === "PUT" ? { payload: { windows } } : {}),
        });
        const allowed = variant === "allowed" || (variant === "operator" && method === "GET");
        expect(response.statusCode).toBe(allowed ? 200 : variant === "missing" ? 401 : 403);
        expect(method === "GET" ? repository.read : repository.replace).toHaveBeenCalledTimes(
          allowed ? 1 : 0,
        );
        if (allowed)
          expect(response.json()).toEqual({ propertyId, paymentDeadlineHours: 48, windows });
      }
    } finally {
      await app.close();
    }
  },
);

it("saves the whole set with the actor, and refuses invalid or too-short bank transfer windows", async () => {
  const { app, repository } = await fixture("allowed");
  try {
    const saved = await app.inject({ method: "PUT", url: path, payload: { windows: {} } });
    expect(saved.statusCode).toBe(200);
    expect(repository.replace).toHaveBeenCalledWith({
      propertyId,
      windows: {},
      audit: { actorUserId: actorId, requestId: "request", correlationId: null },
    });
    for (const payload of [
      {},
      { windows: [] },
      { windows: {}, extra: true },
      { windows: { paypal: { kind: "at_least", amount: 3, unit: "days" } } },
      { windows: { card: { kind: "at_least", amount: 72, unit: "hours" } } },
    ])
      expect((await app.inject({ method: "PUT", url: path, payload })).json()).toEqual({
        code: "invalid_request",
      });
    const short = await app.inject({
      method: "PUT",
      url: path,
      payload: { windows: { bank_transfer: { kind: "at_least", amount: 2, unit: "days" } } },
    });
    expect(short.statusCode).toBe(422);
    expect(short.json()).toMatchObject({ code: "bank_transfer_window_too_short" });
    expect(repository.replace).toHaveBeenCalledTimes(1);
    // Another save holds the hotel's lock: rethrown for the app's 409 busy_try_again.
    repository.replace.mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    );
    const busy = await app.inject({ method: "PUT", url: path, payload: { windows: {} } });
    expect(busy.statusCode).not.toBe(503);
    expect(busy.json()).not.toEqual({ code: "payment_windows_unavailable" });
    repository.read.mockRejectedValueOnce(new Error("database down"));
    const down = await app.inject({ method: "GET", url: path });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ code: "payment_windows_unavailable" });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/finance/properties/not-a-uuid/payment-windows",
        })
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});
