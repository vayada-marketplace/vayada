import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { vayadaNextPayout } from "./domains/vayadaPaymentPayouts.js";
import { registerFinancePayoutStatementRoutes } from "./routes/financePayoutStatement.js";

// VAY-2584: the hotel's own payout statement is the owner's, like the payout account (VAY-2401).
const propertyId = "25840000-0000-4000-8000-000000000001";
const otherHotel = "25840000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const statement = {
  totals: [],
  account: { accountLast4: "6789", countryCode: "ID" },
  payouts: [],
  lines: [],
};
const today = new Date("2026-11-25T10:00:00Z");
const path = (id = propertyId) => `/api/finance/properties/${id}/payout-statement`;

async function appFor(variant: "missing" | "permission" | "manager" | "owner") {
  const repository = { statement: vi.fn(async () => statement) };
  const app = Fastify();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (variant === "missing") return;
    request.authContext = {
      actor: { internalUserId: "25840000-0000-4000-8000-000000000004", status: "active" },
      selectedOrganization: { organizationId: "org", kind: "hotel_group", status: "active" },
      membership: {
        roleKey: variant === "manager" ? "agency_manager" : "hotel_owner",
        status: "active",
        permissions:
          variant === "permission"
            ? []
            : [
                "pms.finance.read",
                "pms.operations.manage",
                "booking.settings.manage",
                ...(variant === "manager" ? [] : ["finance.billing.manage"]),
              ],
      },
      linkedResources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
        { ...resource, relationship: "owner", status: "active" },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active", resource }],
      audit: { requestId: "request", receivedAt: "2026-11-25T00:00:00Z" },
    } as RequestContext;
  });
  await app.register(registerFinancePayoutStatementRoutes, {
    prefix: "/api",
    repository,
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "assigned",
        roleKey: variant === "manager" ? "agency_manager" : "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: [propertyId],
      }),
    },
    now: () => today,
  });
  return { app, repository };
}

it.each([
  ["missing", 401],
  ["permission", 403],
  // Staff with finance access but not the owner: payouts are the owner's.
  ["manager", 403],
  ["owner", 200],
] as const)("%s: only the owner reads the statement (%i)", async (variant, status) => {
  const { app, repository } = await appFor(variant);
  try {
    const response = await app.inject({ method: "GET", url: path() });
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    if (status === 200) {
      expect(response.json()).toEqual(statement);
      expect(repository.statement).toHaveBeenCalledWith({ propertyId, today });
    } else expect(repository.statement).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("never reads another hotel's statement, nor one for a malformed id", async () => {
  const { app, repository } = await appFor("owner");
  try {
    // A hotel the owner isn't linked to: the access check refuses it.
    const other = await app.inject({ method: "GET", url: path(otherHotel) });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).not.toBe("missing_permission");
    // Not a hotel id: refused (the access check, like the payout account's, runs first).
    const malformed = await app.inject({ method: "GET", url: path("not-a-uuid") });
    expect([400, 403]).toContain(malformed.statusCode);
    expect(repository.statement).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("tells staff the statement is the owner's (missing_permission)", async () => {
  const { app } = await appFor("manager");
  try {
    const response = await app.inject({ method: "GET", url: path() });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("missing_permission");
  } finally {
    await app.close();
  }
});

it("hides a failed read behind 503", async () => {
  const { app, repository } = await appFor("owner");
  try {
    repository.statement.mockRejectedValueOnce(new Error("connection lost at 10.0.0.1"));
    const response = await app.inject({ method: "GET", url: path() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "payout_statement_unavailable" });
  } finally {
    await app.close();
  }
});

it("puts the next payout on the coming Monday, for stays checking out by the Sunday before", () => {
  expect(vayadaNextPayout(new Date("2026-11-25T10:00:00Z"))).toEqual({
    on: "2026-11-30",
    cutoff: "2026-11-29",
  });
  // On a Sunday: tomorrow, for stays checking out today.
  expect(vayadaNextPayout(new Date("2026-11-29T23:59:00Z"))).toEqual({
    on: "2026-11-30",
    cutoff: "2026-11-29",
  });
  // On a Monday: today, or a week later.
  expect(vayadaNextPayout(new Date("2026-11-23T00:01:00Z"))).toEqual({
    on: "2026-11-23",
    cutoff: "2026-11-22",
  });
  expect(vayadaNextPayout(new Date("2026-11-23T00:01:00Z"), 1)).toEqual({
    on: "2026-11-30",
    cutoff: "2026-11-29",
  });
  // Across a month and a year.
  expect(vayadaNextPayout(new Date("2026-12-29T12:00:00Z"))).toEqual({
    on: "2027-01-04",
    cutoff: "2027-01-03",
  });
});
