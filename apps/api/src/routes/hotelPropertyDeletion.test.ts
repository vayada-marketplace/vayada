import type { LinkedResource } from "@vayada/backend-auth";
import type { HotelPropertyDeletionCheck } from "@vayada/domain-hotels";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  HotelPropertyDeletionError,
  type HotelPropertyDeletionRepository,
} from "../domains/hotelPropertyDeletionRepository.js";
import { registerHotelPropertyDeletionRoutes } from "./hotelPropertyDeletion.js";

// VAY-2493: PMS › Manage Properties.
const organizationId = "10000000-0000-4000-8000-000000000001";
const actorUserId = "50000000-0000-4000-8000-000000000005";
const propertyA = "20000000-0000-4000-8000-00000000000a";
const propertyB = "20000000-0000-4000-8000-00000000000b";
const otherAccountProperty = "20000000-0000-4000-8000-0000000000ff";
const headers = { authorization: "Bearer valid-token" };
const deleteHeaders = { ...headers, "idempotency-key": "delete-a-1" };
const checkUrl = (id: string) => `/api/hotel-setup/properties/${id}/deletion-check`;
const deleteUrl = (id: string) => `/api/hotel-setup/properties/${id}/delete`;

const check: HotelPropertyDeletionCheck = {
  contractVersion: "hotel-property-deletion.v1",
  propertyId: propertyA,
  displayName: "Escape Villa",
  lifecycleRevision: 3,
  accountProperties: 2,
  blockers: [],
  canDelete: true,
};

describe("hotel property deletion routes", () => {
  it.each(["hotel_manager", "hotel_custom", "agency_manager", "front_desk", "owner"])(
    "refuses a %s member on both routes without reaching the repository",
    async (roleKey) => {
      const repository = fakeRepository();
      const app = await routeApp(repository, { roleKey });

      const read = await app.inject({ method: "GET", url: checkUrl(propertyA), headers });
      const write = await app.inject({
        method: "POST",
        url: deleteUrl(propertyA),
        headers: deleteHeaders,
        payload: { expectedLifecycleRevision: 3, confirmationName: "Escape Villa" },
      });

      expect(read.statusCode).toBe(403);
      expect(read.json()).toMatchObject({ code: "account_admin_required" });
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ code: "account_admin_required" });
      expect(repository.check).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("refuses signed-out requests, platform accounts and inactive memberships", async () => {
    const repository = fakeRepository();
    const signedOut = await routeApp(repository, { signedIn: false });
    expect((await signedOut.inject({ method: "GET", url: checkUrl(propertyA) })).statusCode).toBe(
      401,
    );
    await signedOut.close();

    const platform = await routeApp(repository, { kind: "platform" });
    const platformRead = await platform.inject({
      method: "GET",
      url: checkUrl(propertyA),
      headers,
    });
    expect(platformRead.statusCode).toBe(403);
    expect(platformRead.json()).toEqual({ code: "forbidden" });
    await platform.close();

    const suspended = await routeApp(repository, { membershipStatus: "suspended" });
    expect(
      (await suspended.inject({ method: "GET", url: checkUrl(propertyA), headers })).statusCode,
    ).toBe(403);
    await suspended.close();
    expect(repository.check).not.toHaveBeenCalled();
  });

  it("only reaches properties linked to the account", async () => {
    const repository = fakeRepository();
    const app = await routeApp(repository);

    const other = await app.inject({ method: "GET", url: checkUrl(otherAccountProperty), headers });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: "property_not_found" });

    const invalid = await app.inject({ method: "GET", url: checkUrl("not-a-uuid"), headers });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_property_id" });
    expect(repository.check).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the check for the account admin, without caching", async () => {
    const repository = fakeRepository();
    const app = await routeApp(repository);

    const response = await app.inject({ method: "GET", url: checkUrl(propertyA), headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual(check);
    expect(repository.check).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, actorUserId, propertyId: propertyA }),
    );
    await app.close();
  });

  it("answers 404 when the repository finds no deletable property", async () => {
    const repository = fakeRepository({ check: async () => null });
    const app = await routeApp(repository);

    const response = await app.inject({ method: "GET", url: checkUrl(propertyA), headers });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "property_not_found" });
    await app.close();
  });

  it("needs an idempotency key, the revision and the typed name before deleting", async () => {
    const repository = fakeRepository();
    const app = await routeApp(repository);
    const payload = { expectedLifecycleRevision: 3, confirmationName: "Escape Villa" };

    const noKey = await app.inject({ method: "POST", url: deleteUrl(propertyA), headers, payload });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ code: "idempotency_key_required" });

    for (const invalid of [
      {},
      { expectedLifecycleRevision: "3", confirmationName: "Escape Villa" },
      { expectedLifecycleRevision: 0, confirmationName: "Escape Villa" },
      { expectedLifecycleRevision: 3, confirmationName: "  " },
      { expectedLifecycleRevision: 3 },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: deleteUrl(propertyA),
        headers: deleteHeaders,
        payload: invalid,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_property_deletion" });
    }
    expect(repository.delete).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes with the account, actor and request audit", async () => {
    const repository = fakeRepository();
    const app = await routeApp(repository);

    const response = await app.inject({
      method: "POST",
      url: deleteUrl(propertyA),
      headers: deleteHeaders,
      payload: { expectedLifecycleRevision: 3, confirmationName: "Escape Villa" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contractVersion: "hotel-property-deletion.v1",
      propertyId: propertyA,
      deleted: true,
    });
    expect(repository.delete).toHaveBeenCalledWith({
      organizationId,
      actorUserId,
      propertyId: propertyA,
      expectedLifecycleRevision: 3,
      confirmationName: "Escape Villa",
      idempotencyKey: "delete-a-1",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: "2026-11-13T08:00:00.000Z",
      },
    });
    await app.close();
  });

  it.each([
    ["deletion_blocked", 409],
    ["lifecycle_revision_conflict", 409],
    ["property_already_deleted", 409],
    ["confirmation_name_mismatch", 422],
    ["account_admin_required", 403],
    ["property_not_found", 404],
    ["idempotency_key_conflict", 409],
  ] as const)("answers %s with %i", async (code, status) => {
    const blocked = {
      ...check,
      blockers: [{ code: "upcoming_bookings" as const, count: 2 }],
      canDelete: false,
    };
    const repository = fakeRepository({
      delete: async () => {
        throw new HotelPropertyDeletionError(
          code,
          code === "deletion_blocked" ? blocked : undefined,
        );
      },
    });
    const app = await routeApp(repository);

    const response = await app.inject({
      method: "POST",
      url: deleteUrl(propertyA),
      headers: deleteHeaders,
      payload: { expectedLifecycleRevision: 3, confirmationName: "Escape Villa" },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    if (code === "deletion_blocked") expect(response.json().check).toEqual(blocked);
    await app.close();
  });

  it("asks to try again when the property stays locked, and hides unexpected failures", async () => {
    const busy = await routeApp(
      fakeRepository({
        delete: async () => {
          throw new HotelPropertyDeletionError("property_busy");
        },
      }),
    );
    const busyResponse = await busy.inject({
      method: "POST",
      url: deleteUrl(propertyA),
      headers: deleteHeaders,
      payload: { expectedLifecycleRevision: 3, confirmationName: "Escape Villa" },
    });
    expect(busyResponse.statusCode).toBe(503);
    expect(busyResponse.headers["retry-after"]).toBe("5");
    expect(busyResponse.json()).toMatchObject({ code: "property_busy" });
    await busy.close();

    const broken = await routeApp(
      fakeRepository({
        check: async () => {
          throw new Error("connection reset");
        },
      }),
    );
    const brokenResponse = await broken.inject({
      method: "GET",
      url: checkUrl(propertyB),
      headers,
    });
    expect(brokenResponse.statusCode).toBe(503);
    expect(brokenResponse.json()).toEqual({
      code: "property_deletion_unavailable",
      detail: "Deleting properties is not available right now. Try again later.",
    });
    await broken.close();
  });
});

function fakeRepository(
  overrides: Partial<Pick<HotelPropertyDeletionRepository, "check" | "delete">> = {},
) {
  return {
    check: vi.fn(overrides.check ?? (async () => check)),
    delete: vi.fn(
      overrides.delete ??
        (async () => ({
          contractVersion: "platform-property-lifecycle.v1" as const,
          propertyId: propertyA,
          lifecycleStatus: "retired" as const,
          lifecycleRevision: 4,
        })),
    ),
    close: vi.fn(async () => {}),
  } satisfies HotelPropertyDeletionRepository;
}

async function routeApp(
  repository: HotelPropertyDeletionRepository,
  options: {
    signedIn?: boolean;
    roleKey?: string;
    kind?: "hotel_group" | "platform";
    membershipStatus?: "active" | "suspended";
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
        providerIdentity: { provider: "workos", providerUserId: "user_admin" },
        email: "admin@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId,
        kind: options.kind ?? "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: "723e4567-e89b-42d3-a456-426614174000",
        status: options.membershipStatus ?? "active",
        roleKey: options.roleKey ?? "hotel_owner",
        workosRoleSlugs: ["hotel_admin"],
        permissions: ["hotel_catalog.setup.manage"],
      },
      linkedResources: [link(propertyA), link(propertyB)],
      entitlements: [],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: "2026-11-13T08:00:00.000Z",
      },
    };
  });
  await app.register(registerHotelPropertyDeletionRoutes, {
    prefix: "/api/hotel-setup",
    repository,
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
