import type { LinkedResource, PermissionKey } from "@vayada/backend-auth";
import { defaultAccountBookingPageSettings } from "@vayada/domain-booking";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  AccountBookingPageSaveError,
  AccountBookingPageSummary,
  AccountBookingPagesRepository,
} from "./domains/accountBookingPages.js";
import { registerAccountBookingPageRoutes } from "./routes/accountBookingPages.js";

// VAY-2456: Booking Admin › Settings › Multi-property booking engine.
const organizationId = "10000000-0000-4000-8000-000000000001";
const actorUserId = "50000000-0000-4000-8000-000000000005";
const propertyA = "20000000-0000-4000-8000-00000000000a";
const propertyB = "20000000-0000-4000-8000-00000000000b";
const url = "/api/booking/account-booking-page";
const headers = { authorization: "Bearer valid-token" };

const settings = defaultAccountBookingPageSettings("The Travel Ubud");
const summary: AccountBookingPageSummary = {
  saved: false,
  page: { slug: "the-travel-ubud", live: false, revision: 0, settings, propertyIds: [propertyA] },
  defaults: settings,
  properties: [
    {
      propertyId: propertyA,
      name: "Escape Villa",
      propertyType: "villa",
      area: "Ubud",
      ready: true,
      missing: [],
      included: false,
    },
  ],
  canSave: true,
};
const body = {
  revision: 0,
  slug: "thetravelubud",
  live: true,
  settings,
  propertyIds: [propertyB, propertyA],
};

describe("Agency booking page routes", () => {
  it("reads the selected account's page without caching", async () => {
    const repository = repositoryFake();
    const app = await routeApp(repository);
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual(summary);
    expect(repository.read).toHaveBeenCalledWith(organizationId);
    await app.close();
  });

  it("saves for the selected account with the member as the audit actor", async () => {
    const repository = repositoryFake();
    const app = await routeApp(repository);
    const response = await app.inject({ method: "PUT", url, headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repository.save).toHaveBeenCalledWith({
      organizationId,
      update: body,
      audit: { actorUserId, requestId: "request-1", correlationId: "correlation-1" },
    });
    await app.close();
  });

  it("refuses an invalid save before it reaches the repository", async () => {
    const repository = repositoryFake();
    const app = await routeApp(repository);
    for (const payload of [
      { ...body, extra: true },
      { ...body, slug: "The Travel Ubud" },
      { ...body, propertyIds: [propertyA, propertyA] },
      { ...body, settings: { ...settings, layout: { allowed: ["map"], default: "map" } } },
    ]) {
      const response = await app.inject({ method: "PUT", url, headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_account_booking_page" });
    }
    expect(repository.save).not.toHaveBeenCalled();
    await app.close();
  });

  it("answers each refusal with its status and a message", async () => {
    const expected: Array<[AccountBookingPageSaveError, number]> = [
      ["account_not_found", 404],
      ["page_changed", 409],
      ["slug_taken", 409],
      ["account_needs_two_properties", 422],
      ["property_not_in_account", 422],
      ["property_not_ready", 422],
      ["no_ready_property", 422],
    ];
    for (const [error, status] of expected) {
      const repository = repositoryFake();
      repository.save.mockResolvedValueOnce({ ok: false, error });
      const app = await routeApp(repository);
      const response = await app.inject({ method: "PUT", url, headers, payload: body });
      expect(response.statusCode, error).toBe(status);
      expect(response.json()).toMatchObject({ code: error, message: expect.any(String) });
      await app.close();
    }
  });

  it("answers 503 when the database fails", async () => {
    const repository = repositoryFake();
    repository.read.mockRejectedValueOnce(new Error("down"));
    repository.save.mockRejectedValueOnce(new Error("down"));
    const app = await routeApp(repository);
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(503);
    expect((await app.inject({ method: "PUT", url, headers, payload: body })).statusCode).toBe(503);
    await app.close();
  });

  it("needs a signed-in member with the booking settings permission and access to every property", async () => {
    const cases: Array<[number, Parameters<typeof routeApp>[1]]> = [
      [401, { signedIn: false }],
      [403, { permissions: ["booking.settings.read" as PermissionKey] }],
      [403, { mode: "assigned" }],
      [403, { accessOrigin: "external_owner" }],
      [403, { kind: "platform" }],
    ];
    for (const [status, options] of cases) {
      const repository = repositoryFake();
      const app = await routeApp(repository, options);
      expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(status);
      expect((await app.inject({ method: "PUT", url, headers, payload: body })).statusCode).toBe(
        status,
      );
      expect(repository.read).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
      await app.close();
    }
  });
});

function repositoryFake() {
  return {
    read: vi.fn<AccountBookingPagesRepository["read"]>(async () => summary),
    save: vi.fn<AccountBookingPagesRepository["save"]>(async () => ({
      ok: true as const,
      summary,
    })),
  };
}

async function routeApp(
  repository: AccountBookingPagesRepository,
  options: {
    signedIn?: boolean;
    permissions?: readonly PermissionKey[];
    mode?: "all" | "assigned";
    accessOrigin?: "agency" | "external_owner";
    kind?: "hotel_group" | "platform";
  } = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (options.signedIn === false || request.headers.authorization !== "Bearer valid-token")
      return;
    request.authContext = {
      actor: {
        internalUserId: actorUserId,
        providerIdentity: { provider: "workos", providerUserId: "user_agency" },
        email: "agency@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId,
        kind: options.kind ?? "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: "723e4567-e89b-42d3-a456-426614174000",
        status: "active",
        roleKey: "hotel_owner",
        workosRoleSlugs: ["hotel_admin"],
        permissions: [...(options.permissions ?? ["booking.settings.manage"])],
      },
      linkedResources: [link(propertyA), link(propertyB)],
      entitlements: [],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: "2026-11-02T08:00:00.000Z",
      },
    };
  });
  await app.register(registerAccountBookingPageRoutes, {
    prefix: "/api/booking",
    repository,
    propertyAccessRepository: {
      findMembershipPropertyScope: vi.fn(async () => ({
        mode: options.mode ?? "all",
        roleKey: "hotel_owner",
        accessOrigin: options.accessOrigin ?? "agency",
        assignedPropertyIds: options.mode === "assigned" ? [propertyA] : [],
      })),
    },
  });
  return app;
}

function link(propertyId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    relationship: "owner",
    status: "active",
  };
}
