import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError, type RequestContext } from "@vayada/backend-auth";
import { buildApp } from "./app.js";
import { context, id } from "./domains/affiliatePublicationTestFixture.js";
import {
  registerBookingChargeReportRoutes,
  type BookingChargeReportRoutesOptions,
} from "./routes/bookingChargeReports.js";
const path = `/properties/${id(3)}/bookings/${id(50)}/charge-reports`;
const headers = { authorization: "Bearer valid", "idempotency-key": "report-1" };
const payload = {
  expectedReportId: null,
  reportedItemReference: "room",
  components: { accommodation: "50000", tax: "5000", extras: "10000", other: "0" },
};
function auth(): RequestContext {
  return {
    ...context(),
    membership: { ...context().membership, permissions: ["booking.settings.manage"] },
    linkedResources: [
      {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: id(3),
        status: "active",
        relationship: "owner",
      },
    ],
    entitlements: [{ product: "booking", key: "booking-engine", status: "active" }],
  };
}
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(mutate: (c: RequestContext) => void = () => {}) {
  const refreshContext = vi
    .fn<BookingChargeReportRoutesOptions["refreshContext"]>()
    .mockImplementation(async () => auth());
  const submit = vi
    .fn<BookingChargeReportRoutesOptions["submit"]>()
    .mockImplementation(async (_input, fresh) => {
      await fresh();
      return { ok: true, reportId: id(60), replayed: false, status: "unverified" };
    });
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "Bearer valid") {
      const c = auth();
      mutate(c);
      request.authContext = c;
    }
  });
  await app.register(registerBookingChargeReportRoutes, { submit, refreshContext });
  return {
    app,
    submit,
    refreshContext,
    post: (body: unknown = payload, h: Record<string, string | string[]> = headers) =>
      app.inject({ method: "POST", url: path, headers: h, payload: body as object }),
  };
}
describe("Booking charge report HTTP boundary", () => {
  it("uses canonical URL scope and header identity and does not cache responses", async () => {
    const s = await setup(),
      response = await s.post();
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(s.submit).toHaveBeenCalledWith(
      { ...payload, propertyId: id(3), bookingId: id(50), sourceRevision: "report-1" },
      expect.any(Function),
    );
    expect(s.refreshContext).toHaveBeenCalledOnce();
  });
  it("denies missing/invalid authentication before command access", async () => {
    const s = await setup();
    for (const authorization of ["", "Bearer invalid"]) {
      const response = await s.post(payload, { ...headers, authorization });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(s.submit).not.toHaveBeenCalled();
  });
  it("denies permission, entitlement, inactive and cross-resource cases", async () => {
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
      (c: RequestContext) => {
        c.entitlements = [];
      },
      (c: RequestContext) => {
        c.entitlements[0]!.status = "suspended";
      },
      (c: RequestContext) => {
        c.linkedResources = [];
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.resourceId = id(99);
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.status = "suspended";
      },
      (c: RequestContext) => {
        c.linkedResources[0]!.relationship = "front_desk";
      },
      (c: RequestContext) => {
        c.actor.status = "suspended";
      },
      (c: RequestContext) => {
        c.membership.status = "inactive";
      },
      (c: RequestContext) => {
        c.selectedOrganization.status = "suspended";
      },
      (c: RequestContext) => {
        c.selectedOrganization.kind = "creator_workspace";
      },
    ]) {
      const s = await setup(mutate);
      const response = await s.post();
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(s.submit).not.toHaveBeenCalled();
    }
  });
  it("rejects malformed scope, ambiguous headers and forged server fields", async () => {
    const s = await setup();
    for (const field of [
      "purpose",
      "environment",
      "sourceRevision",
      "propertyId",
      "organizationId",
    ]) {
      expect((await s.post({ ...payload, [field]: "forged" })).statusCode).toBe(422);
    }
    for (const key of ["", " key", ["a", "b"]])
      expect((await s.post(payload, { ...headers, "idempotency-key": key })).statusCode).toBe(422);
    expect((await s.post({ ...payload, expectedReportId: "invalid" })).statusCode).toBe(422);
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: path.replace(id(3), "invalid"),
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(422);
    expect(s.submit).not.toHaveBeenCalled();
  });
  it("maps replay and command failures", async () => {
    const s = await setup();
    s.submit.mockResolvedValueOnce({
      ok: true,
      reportId: id(60),
      replayed: true,
      status: "unverified",
    });
    expect((await s.post()).statusCode).toBe(200);
    for (const [code, status] of [
      ["invalid_request", 422],
      ["scope_unavailable", 404],
      ["source_unavailable", 409],
      ["revision_conflict", 409],
      ["idempotency_conflict", 409],
    ] as const) {
      s.submit.mockResolvedValueOnce({ ok: false, code });
      const response = await s.post();
      expect(response.statusCode).toBe(status);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
  it("pins the refreshed identity, rechecks permission and sanitizes failures", async () => {
    const s = await setup();
    for (const mutate of [
      (c: RequestContext) => {
        c.actor.internalUserId = id(99);
      },
      (c: RequestContext) => {
        c.selectedOrganization.organizationId = id(99);
      },
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
    ]) {
      const c = auth();
      mutate(c);
      s.refreshContext.mockResolvedValueOnce(c);
      expect((await s.post()).statusCode).toBe(403);
    }
    s.refreshContext.mockImplementationOnce(async (request) => {
      const current = request.authContext!;
      current.selectedOrganization.organizationId = id(99);
      return current;
    });
    expect((await s.post()).statusCode).toBe(403);
    s.refreshContext.mockRejectedValueOnce(new AuthError("TOKEN_EXPIRED", "private token detail"));
    expect((await s.post()).statusCode).toBe(401);
    s.submit.mockRejectedValueOnce(new Error("private database detail"));
    const response = await s.post();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("registers only when explicitly composed in buildApp", async () => {
    const submit = vi.fn<BookingChargeReportRoutesOptions["submit"]>();
    const refreshContext = async () => auth();
    const disabled = buildApp({ logger: false }),
      enabled = buildApp({ logger: false, bookingChargeReports: { submit, refreshContext } });
    apps.push(disabled, enabled);
    expect(
      (await disabled.inject({ method: "POST", url: `/api/booking${path}`, payload })).statusCode,
    ).toBe(404);
    expect(
      (await enabled.inject({ method: "POST", url: `/api/booking${path}`, payload })).statusCode,
    ).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });
});
