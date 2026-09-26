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
    readForCollaboration: vi
      .fn<AffiliateAssentRepository["readForCollaboration"]>()
      .mockResolvedValue(null),
    recordForCollaboration: vi
      .fn<AffiliateAssentRepository["recordForCollaboration"]>()
      .mockResolvedValue({ ok: false, code: "scope_unavailable" }),
    changeLifecycleForCollaboration: vi
      .fn<AffiliateAssentRepository["changeLifecycleForCollaboration"]>()
      .mockResolvedValue({ ok: false, code: "scope_unavailable" }),
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
      lifecycle: null,
    };
    repository.read.mockResolvedValue(result);
    repository.readForCollaboration.mockResolvedValue(result);
    const linked = await app.inject({
      url: "/collaborations/Existing:QA/affiliate-assent",
      headers,
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual(result);
    expect(linked.headers["cache-control"]).toBe("no-store");
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
  it("resolves opaque collaboration keys through the protected lookup", async () => {
    const { app, repository } = await setup();
    const source = "Existing-Collaboration:QA";
    const url = `/collaborations/${encodeURIComponent(source)}/affiliate-assent`;
    for (const authorization of [undefined, "Bearer invalid"]) {
      const response = await app.inject({ url, headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(repository.readForCollaboration).not.toHaveBeenCalled();
    const missing = await app.inject({ url, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "scope_unavailable" });
    expect(repository.readForCollaboration).toHaveBeenCalledWith(expect.any(Object), source);
    for (const invalid of [" ", " padded ", "bad\u0001key", "has/slash", "has%escape"]) {
      expect(
        (
          await app.inject({
            url: `/collaborations/${encodeURIComponent(invalid)}/affiliate-assent`,
            headers,
          })
        ).statusCode,
      ).toBe(422);
    }
    expect(
      (await app.inject({ url: `/collaborations/${"a".repeat(101)}/affiliate-assent`, headers }))
        .statusCode,
    ).toBe(404);
    expect(repository.readForCollaboration).toHaveBeenCalledTimes(1);
    repository.readForCollaboration.mockRejectedValue(new Error("private database detail"));
    const failed = await app.inject({ url, headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ code: "read_unavailable" });
    expect(failed.headers["cache-control"]).toBe("no-store");
    const denied = await setup((c) => {
      c.membership.permissions = [];
    });
    expect((await denied.app.inject({ url, headers })).statusCode).toBe(403);
    expect(denied.repository.readForCollaboration).not.toHaveBeenCalled();
  });
  it("records only a server-resolved collaboration decision with one idempotency key", async () => {
    const { app, repository } = await setup((context) => {
      context.membership.permissions.push("marketplace.collaboration.write");
    });
    repository.recordForCollaboration.mockResolvedValue({
      ok: true,
      revision: 1,
      state: "pending",
      replayed: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/collaborations/Existing:QA/affiliate-assent",
      headers: { ...headers, "idempotency-key": "decision-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, revision: 1, state: "pending", replayed: false });
    expect(repository.recordForCollaboration).toHaveBeenCalledWith(
      expect.any(Object),
      "Existing:QA",
      "decision-1",
    );

    for (const request of [
      { headers },
      { headers: { ...headers, "idempotency-key": "decision-2" }, payload: { termsId: attemptId } },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/collaborations/Existing:QA/affiliate-assent",
            ...request,
          })
        ).statusCode,
      ).toBe(422);
    }
    expect(repository.recordForCollaboration).toHaveBeenCalledTimes(1);

    const denied = await setup();
    expect(
      (
        await denied.app.inject({
          method: "POST",
          url: "/collaborations/Existing:QA/affiliate-assent",
          headers: { ...headers, "idempotency-key": "decision-1" },
        })
      ).statusCode,
    ).toBe(403);
    expect(denied.repository.recordForCollaboration).not.toHaveBeenCalled();
  });
  it("changes only a server-resolved agreement lifecycle with one exact command", async () => {
    const { app, repository } = await setup((context) => {
      context.membership.permissions.push("marketplace.collaboration.write");
    });
    repository.changeLifecycleForCollaboration.mockResolvedValue({
      ok: true,
      eventId: attemptId,
      revision: 2,
      effectiveAt: "2026-09-27T00:00:00.000Z",
      replayed: false,
    });
    const url = "/collaborations/Existing:QA/affiliate-lifecycle";
    const payload = { action: "pause", reason: "Paused in Marketplace", expectedRevision: 1 };
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...headers, "idempotency-key": "lifecycle-1" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(repository.changeLifecycleForCollaboration).toHaveBeenCalledWith(
      expect.any(Object),
      "Existing:QA",
      { ...payload, idempotencyKey: "lifecycle-1" },
    );
    for (const invalid of [
      { headers, payload },
      {
        headers: { ...headers, "idempotency-key": "lifecycle-2" },
        payload: { ...payload, extra: true },
      },
      {
        headers: { ...headers, "idempotency-key": "lifecycle-3" },
        payload: { ...payload, reason: " padded " },
      },
    ])
      expect((await app.inject({ method: "POST", url, ...invalid })).statusCode).toBe(422);
    expect(repository.changeLifecycleForCollaboration).toHaveBeenCalledTimes(1);
  });
  it("registers the production prefix and keeps upstream auth failures uncached", async () => {
    const repository = {
      read: vi.fn(),
      readForCollaboration: vi.fn(),
      recordForCollaboration: vi.fn(),
      changeLifecycleForCollaboration: vi.fn(),
      close: async () => {},
    };
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
