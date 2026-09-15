import Fastify from "fastify";
import type { RequestContext, IdentityRepository } from "@vayada/backend-auth";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { registerMarketplaceAffiliateEvidenceRoutes } from "./routes/marketplaceAffiliateEvidence.js";
const propertyId = "15050000-0000-4000-8000-000000000002";
const observationId = "15050000-0000-4000-8000-000000000003";
const path = `/properties/${propertyId}/affiliate-evidence/${observationId}`;
const headers = { authorization: "Bearer valid" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(mutate: (context: RequestContext) => void = () => {}) {
  const app = Fastify();
  apps.push(app);
  const repository = {
    read: vi.fn().mockResolvedValue({ observationId, deliveries: [], nextCursor: null }),
    close: vi.fn(async () => {}),
  };
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid") return;
    const context = {
      actor: { status: "active" },
      membership: { status: "active", permissions: ["marketplace.profile.manage"] },
      selectedOrganization: { organizationId: "org-1", kind: "hotel_group", status: "active" },
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: propertyId,
          status: "active",
          relationship: "owner",
        },
      ],
      entitlements: [
        { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
      ],
    } as RequestContext;
    mutate(context);
    request.authContext = context;
  });
  await app.register(registerMarketplaceAffiliateEvidenceRoutes, { repository });
  return { app, repository };
}
it("reads exact authorized scope and keeps successful, missing and failed reads uncached", async () => {
  const { app, repository } = await setup();
  const response = await app.inject({ url: path, headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(repository.read).toHaveBeenCalledWith(propertyId, "org-1", observationId, null);
  await app.inject({ url: `${path}?after=${observationId}`, headers });
  expect(repository.read).toHaveBeenLastCalledWith(
    propertyId,
    "org-1",
    observationId,
    observationId,
  );
  repository.read.mockResolvedValueOnce(null);
  expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
  repository.read.mockRejectedValueOnce(new Error("database unavailable"));
  const failed = await app.inject({ url: path, headers });
  expect(failed.statusCode).toBe(500);
  expect(failed.headers["cache-control"]).toBe("no-store");
});
it("denies absent/invalid auth and malformed cursor/IDs before reading", async () => {
  const { app, repository } = await setup();
  for (const authorization of [undefined, "Bearer invalid"]) {
    const result = await app.inject({ url: path, headers: authorization ? { authorization } : {} });
    expect(result.statusCode).toBe(401);
    expect(result.headers["cache-control"]).toBe("no-store");
  }
  for (const url of [
    path.replace(observationId, "bad"),
    `${path}?after=bad`,
    `${path}?after=${observationId}&after=${observationId}`,
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(422);
  expect(repository.read).not.toHaveBeenCalled();
});
it("allows an operator with an entitlement scoped to this property", async () => {
  const { app, repository } = await setup((context) => {
    context.linkedResources[0]!.relationship = "operator";
    context.entitlements[0]!.resource = {
      product: "marketplace",
      resourceType: "hotel_profile",
      resourceId: propertyId,
    };
  });
  expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
  expect(repository.read).toHaveBeenCalledWith(propertyId, "org-1", observationId, null);
});
it("enforces the complete identity, permission, entitlement and property denial matrix", async () => {
  const denials: ((context: RequestContext) => void)[] = [
    (c) => {
      c.membership.permissions = [];
    },
    (c) => {
      c.entitlements = [];
    },
    (c) => {
      c.entitlements[0]!.status = "suspended";
    },
    (c) => {
      c.entitlements[0]!.resource = {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: observationId,
      };
    },
    (c) => {
      c.linkedResources = [];
    },
    (c) => {
      c.linkedResources[0]!.relationship = "front_desk";
    },
    (c) => {
      c.linkedResources[0]!.status = "suspended";
    },
    (c) => {
      c.linkedResources[0]!.resourceId = observationId;
    },
    (c) => {
      c.actor.status = "suspended";
    },
    (c) => {
      c.membership.status = "inactive";
    },
    (c) => {
      c.selectedOrganization.status = "suspended";
    },
    (c) => {
      c.selectedOrganization.kind = "creator_workspace";
    },
  ];
  for (const mutate of denials) {
    const { app, repository } = await setup(mutate);
    const result = await app.inject({ url: path, headers });
    expect(result.statusCode).toBe(403);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(repository.read).not.toHaveBeenCalled();
  }
});
it("mounts in the real app and keeps upstream authentication failures uncached", async () => {
  const repository = { read: vi.fn(), close: vi.fn(async () => {}) };
  const app = buildApp({
    logger: false,
    marketplaceAffiliateEvidenceReviewRepository: repository,
    auth: {
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: { findPermissionsForRole: async () => [] },
      repository: {} as IdentityRepository,
      verifier: async () => {
        throw Object.assign(new Error("auth unavailable"), { code: "53300" });
      },
    },
  });
  apps.push(app);
  const result = await app.inject({ url: `/api/marketplace${path}`, headers });
  expect(result.statusCode).toBe(503);
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(repository.read).not.toHaveBeenCalled();
});
