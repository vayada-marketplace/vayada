import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityRepository, RequestContext } from "@vayada/backend-auth";
import { assentInput } from "./domains/affiliateAssentCommandTestFixture.js";
import type { AffiliateAssentRepository } from "./domains/marketplaceAffiliateAssentRepository.js";
import { registerMarketplaceAffiliateAssentRoutes } from "./routes/marketplaceAffiliateAssent.js";
import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
const attemptId = "abcdef00-0000-4000-8000-000000000100";
const path = `/affiliate-attempts/${attemptId}`;
const headers = { authorization: "Bearer valid" };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(mutate: (c: RequestContext) => void = () => {}) {
  const repository = {
    read: vi.fn<AffiliateAssentRepository["read"]>().mockResolvedValue(null),
    close: vi.fn<AffiliateAssentRepository["close"]>().mockResolvedValue(undefined),
  };
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid") return;
    const c = assentInput().context;
    c.membership.permissions = ["marketplace.collaboration.read"];
    mutate(c);
    request.authContext = c;
  });
  await app.register(registerMarketplaceAffiliateAssentRoutes, { repository });
  return { app, repository };
}
describe("Affiliate assent HTTP read", () => {
  it("denies missing or invalid auth and permission before the repository", async () => {
    const { app, repository } = await setup();
    for (const token of [undefined, "Bearer invalid"]) {
      const response = await app.inject({
        url: path,
        headers: token ? { authorization: token } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(repository.read).not.toHaveBeenCalled();
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
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
    ]) {
      const s = await setup(mutate);
      const response = await s.app.inject({ url: path, headers });
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(s.repository.read).not.toHaveBeenCalled();
    }
  });
  it("normalizes IDs, passes trusted context and uses the same missing-scope response", async () => {
    const { app, repository } = await setup();
    const response = await app.inject({
      url: path.toUpperCase().replace("/AFFILIATE-ATTEMPTS/", "/affiliate-attempts/"),
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "scope_unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repository.read).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ status: "active" }) }),
      attemptId,
    );
    expect((await app.inject({ url: "/affiliate-attempts/invalid", headers })).statusCode).toBe(
      422,
    );
    expect(repository.read).toHaveBeenCalledTimes(1);
  });
  it("returns the read model and hides internal storage errors", async () => {
    const { app, repository } = await setup();
    const result = {
      participationId: attemptId,
      attemptId,
      programId: attemptId,
      propertyId: attemptId,
      offerId: attemptId,
      creatorProfileId: attemptId,
      origin: "invitation" as const,
      revision: 1,
      assentState: "pending" as const,
      terms: { id: attemptId, disclosure: "{}", disclosureHash: "hash" },
      hotelApprovedAt: "2026-09-16T00:00:00.000Z",
      creatorAcceptedAt: null,
    };
    repository.read.mockResolvedValue(result);
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers["cache-control"]).toBe("no-store");
    repository.read.mockRejectedValue(new Error("private SQL details"));
    const failed = await app.inject({ url: path, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ code: "read_unavailable" });
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ method: "POST", url: path, headers })).statusCode).toBe(404);
  });
  it("registers the production prefix and keeps upstream auth failures uncached", async () => {
    const repository = { read: vi.fn(), close: async () => {} };
    const app = buildApp({
      logger: false,
      marketplaceAffiliateAssentRepository: repository,
      auth: {
        propertyAccessRepository: agencyPropertyAccessRepository,
        rolePermissionRepository: { findPermissionsForRole: async () => [] },
        verifier: async () => {
          throw Object.assign(new Error("unavailable"), { code: "53300" });
        },
        repository: {} as IdentityRepository,
      },
    });
    apps.push(app);
    const response = await app.inject({ url: `/api/marketplace${path}`, headers });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repository.read).not.toHaveBeenCalled();
  });
});
