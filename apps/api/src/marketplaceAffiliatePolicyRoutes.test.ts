import {
  backendAuthPlugin,
  type IdentityRepository,
  type RequestContext,
} from "@vayada/backend-auth";
import Fastify from "fastify";
import { parseFinanceAffiliatePercentagePolicy } from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";
import { registerMarketplaceAffiliatePolicyRoutes } from "./routes/marketplaceAffiliatePolicies.js";
import type { AffiliatePolicyRepository } from "./domains/financeAffiliatePercentagePolicyRepository.js";
const propertyId = "15010000-0000-4000-8000-000000000003";
const versionId = "15010000-0000-4000-8000-000000000002";
const path = `/properties/${propertyId}/affiliate-policies`;
const headers = { authorization: "Bearer valid", "idempotency-key": "request-1" };
const endpoints = [
  { method: "GET" as const, url: `${path}/${versionId}` },
  { method: "POST" as const, url: path, payload: { percentageRate: "12.50" } },
  { method: "POST" as const, url: `${path}/${versionId}/approve` },
];
async function setup(mutate: (c: RequestContext) => void = () => {}, authFailure = false) {
  const app = Fastify();
  const repository = {
    save: vi
      .fn<AffiliatePolicyRepository["save"]>()
      .mockResolvedValue({ ok: true, policyVersionId: versionId, replayed: false }),
    approve: vi
      .fn<AffiliatePolicyRepository["approve"]>()
      .mockResolvedValue({ ok: true, policyVersionId: versionId, replayed: false }),
    resolve: vi
      .fn<AffiliatePolicyRepository["resolve"]>()
      .mockResolvedValue({ status: "unavailable", reason: "not_approved" }),
    close: vi.fn<AffiliatePolicyRepository["close"]>().mockResolvedValue(undefined),
  };
  if (authFailure) {
    await app.register(backendAuthPlugin, {
      verifier: async () => {
        throw new Error("database unavailable");
      },
      repository: {} as IdentityRepository,
    });
  } else {
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      if (request.headers.authorization !== "Bearer valid") return;
      const context = {
        actor: { internalUserId: "actor-1", status: "active" },
        membership: { status: "active", permissions: ["marketplace.profile.manage"] },
        selectedOrganization: {
          organizationId: "hotel-org",
          kind: "hotel_group",
          status: "active",
        },
        linkedResources: [
          {
            product: "marketplace",
            resourceType: "hotel_profile",
            resourceId: propertyId,
            relationship: "owner",
            status: "active",
          },
        ],
        entitlements: [
          { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
        ],
        audit: { requestId: "request-1" },
      } as RequestContext;
      mutate(context);
      request.authContext = context;
    });
  }
  await app.register(registerMarketplaceAffiliatePolicyRoutes, { repository });
  return { app, repository };
}
describe("Marketplace affiliate policy HTTP", () => {
  it("passes authorized scope to save/approve and exact reference to resolve", async () => {
    const { app, repository } = await setup();
    try {
      expect((await app.inject({ ...endpoints[1]!, headers })).statusCode).toBe(201);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          propertyId,
          policy: { percentageRate: "12.50" },
          idempotencyKey: "request-1",
          context: expect.objectContaining({
            selectedOrganization: expect.objectContaining({ organizationId: "hotel-org" }),
          }),
        }),
      );
      expect((await app.inject({ ...endpoints[2]!, headers })).statusCode).toBe(201);
      expect(repository.approve).toHaveBeenCalledWith(
        expect.objectContaining({ propertyId, policyVersionId: versionId }),
      );
      const result = await app.inject({ ...endpoints[0]!, headers });
      expect(result.statusCode).toBe(409);
      expect(result.json().reason).toBe("not_approved");
      expect(repository.resolve).toHaveBeenCalledWith({ propertyId, policyVersionId: versionId });
    } finally {
      await app.close();
    }
    expect(repository.close).toHaveBeenCalledOnce();
  });
  it("keeps upstream authentication infrastructure failures uncached", async () => {
    const { app } = await setup(undefined, true);
    try {
      for (const endpoint of endpoints) {
        const response = await app.inject({ ...endpoint, headers });
        expect(response.statusCode).toBe(500);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });
  it("denies absent or invalid authentication on every endpoint", async () => {
    const { app, repository } = await setup();
    try {
      for (const authorization of [undefined, "Bearer invalid"])
        for (const endpoint of endpoints) {
          const result = await app.inject({
            ...endpoint,
            headers: authorization ? { authorization } : {},
          });
          expect(result.statusCode).toBe(401);
          expect(result.headers["cache-control"]).toBe("no-store");
        }
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.approve).not.toHaveBeenCalled();
      expect(repository.resolve).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("denies permission, entitlement, resource and inactive identity failures before repository access", async () => {
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
      const { app, repository } = await setup(mutate);
      try {
        for (const endpoint of endpoints)
          expect((await app.inject({ ...endpoint, headers })).statusCode).toBe(403);
        expect(repository.save).not.toHaveBeenCalled();
        expect(repository.approve).not.toHaveBeenCalled();
        expect(repository.resolve).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it("requires bounded unique retry keys, valid IDs and body-free approval", async () => {
    const { app, repository } = await setup();
    try {
      for (const key of [undefined, " ", "a".repeat(201), ["one", "two"]])
        for (const endpoint of endpoints.slice(1)) {
          const response = await app.inject({
            ...endpoint,
            headers: { authorization: "Bearer valid", ...(key ? { "idempotency-key": key } : {}) },
          });
          expect(response.statusCode).toBe(422);
        }
      expect(
        (await app.inject({ ...endpoints[2]!, headers, payload: { policyVersionId: versionId } }))
          .statusCode,
      ).toBe(422);
      expect((await app.inject({ method: "GET", url: `${path}/bad`, headers })).statusCode).toBe(
        422,
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/properties/15010000-0000-4000-8000-000000000099/affiliate-policies/${versionId}`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.approve).not.toHaveBeenCalled();
      expect(repository.resolve).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("maps domain outcomes without claiming publication readiness", async () => {
    const { app, repository } = await setup();
    try {
      for (const [code, status] of [
        ["invalid_request", 422],
        ["scope_unavailable", 404],
        ["idempotency_conflict", 409],
      ] as const) {
        repository.save.mockResolvedValue({ ok: false, code });
        expect((await app.inject({ ...endpoints[1]!, headers })).statusCode).toBe(status);
        repository.approve.mockResolvedValue({ ok: false, code });
        expect((await app.inject({ ...endpoints[2]!, headers })).statusCode).toBe(status);
      }
      repository.approve.mockResolvedValue({ ok: false, code: "already_approved" });
      expect((await app.inject({ ...endpoints[2]!, headers })).statusCode).toBe(409);
      repository.save.mockResolvedValue({ ok: true, policyVersionId: versionId, replayed: true });
      expect((await app.inject({ ...endpoints[1]!, headers })).statusCode).toBe(200);
      repository.approve.mockResolvedValue({
        ok: true,
        policyVersionId: versionId,
        replayed: true,
      });
      expect((await app.inject({ ...endpoints[2]!, headers })).statusCode).toBe(200);
      repository.resolve.mockResolvedValue({
        status: "available",
        propertyId,
        policyVersionId: versionId,
        policy: parseFinanceAffiliatePercentagePolicy({ percentageRate: "12.50" })!,
      });
      const available = await app.inject({ ...endpoints[0]!, headers });
      expect(available.statusCode).toBe(200);
      expect(available.json().policy.percentageRate).toBe("12.50");
      expect(available.headers["cache-control"]).toBe("no-store");
      for (const reason of ["not_found", "not_approved", "invalid_policy"] as const) {
        repository.resolve.mockResolvedValue({ status: "unavailable", reason });
        expect((await app.inject({ ...endpoints[0]!, headers })).statusCode).toBe(
          reason === "not_found" ? 404 : 409,
        );
      }
      repository.resolve.mockRejectedValue(new Error("database unavailable"));
      expect((await app.inject({ ...endpoints[0]!, headers })).statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});
