// The one-shot delegated scope through the real backend-auth onRequest hook (VAY-2506).
// Mechanism and the callback-form rule come from the VAY-2500 spike: if injectAsDelegate ever
// switched to the promise form of app.inject, the first test here would get a 401.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { narrowDelegatedContext } from "./delegatedContext.js";
import { injectAsDelegate, type DelegatedRouteGate } from "./delegatedScope.js";
import { DelegationRefusedError } from "./errors.js";
import { backendAuthPlugin, requireAuthContext } from "./plugin.js";
import type { IdentityRepository } from "./repository.js";
import type { RequestContext } from "./types.js";
import { createFakeVerifier } from "./verify.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";

function delegatedContext(userId: string): RequestContext {
  return narrowDelegatedContext({
    actor: {
      internalUserId: userId,
      providerIdentity: { provider: "workos", providerUserId: `wos_${userId}` },
      email: `${userId}@example.test`,
      status: "active",
    },
    selectedOrganization: { organizationId: "org_1", kind: "hotel_group", status: "active" },
    membership: {
      membershipId: `m_${userId}`,
      status: "active",
      roleKey: "hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
      permissions: [],
      propertyAccess: {
        mode: "all",
        roleKey: "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: [],
      },
    },
    linkedResources: [
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: PROPERTY,
        relationship: "owner",
        status: "active",
      },
    ],
    entitlements: [],
    locale: "en",
    currency: "USD",
    audit: {
      requestId: `tool_call_${userId}`,
      source: "agent",
      receivedAt: "1970-01-01T00:00:00Z",
    },
    delegation: { channel: "in_app", conversationId: PROPERTY, toolCallId: `tool_call_${userId}` },
  });
}

const refusingRepository = new Proxy({} as IdentityRepository, {
  get() {
    return async () => {
      throw new Error("the bearer path must not reach the identity repository here");
    };
  },
});

type Recorded = { status: number; body: unknown };
const later: Promise<Recorded>[] = [];
const servers: Server[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  later.length = 0;
  await app?.close();
  app = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

function whoami(request: FastifyRequest) {
  const ctx = requireAuthContext(request);
  return {
    userId: ctx.actor.internalUserId,
    source: ctx.audit.source,
    sessionId: ctx.actor.providerIdentity.sessionId ?? null,
    toolCallId: ctx.delegation?.toolCallId ?? null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allowAll: DelegatedRouteGate = { allowsRoute: () => true };

async function buildTestApp(
  options: { gate?: DelegatedRouteGate | null; addBearerFirst?: boolean } = {},
) {
  const instance = Fastify({ logger: false });
  if (options.addBearerFirst) {
    // Runs before the auth hook: a delegated request must never also carry a bearer token.
    instance.addHook("onRequest", async (request) => {
      request.headers.authorization = "Bearer smuggled";
    });
  }
  await instance.register(backendAuthPlugin, {
    verifier: createFakeVerifier(new Map()),
    repository: refusingRepository,
    skipPathPrefixes: ["/partner/"],
    ...(options.gate === null ? {} : { delegation: options.gate ?? allowAll }),
  });

  instance.get("/api/test/whoami", async (request) => whoami(request));
  instance.get("/api/test/other", async (request) => whoami(request));
  instance.post("/api/test/whoami", async (request) => whoami(request));
  instance.get("/partner/v1/hotel", async (request) => ({ context: request.authContext !== null }));
  instance.get("/api/test/slow/:ms", async (request) => {
    await sleep(Number((request.params as { ms: string }).ms));
    return whoami(request);
  });
  // The handler of a delegated request injects another route without a scope of its own.
  instance.get("/api/test/nested-raw", async (request) => {
    whoami(request);
    const inner = await instance.inject({ method: "GET", url: "/api/test/whoami" });
    return { innerStatus: inner.statusCode, innerBody: inner.json() };
  });
  // The handler tries to start a second delegation.
  instance.get("/api/test/nested-delegate", async (request) => {
    whoami(request);
    try {
      await injectAsDelegate(instance, {
        context: delegatedContext("u_nested"),
        method: "GET",
        routeUrl: "/api/test/whoami",
        url: "/api/test/whoami",
      });
      return { refused: false };
    } catch (error) {
      return { refused: error instanceof DelegationRefusedError };
    }
  });
  // Work that outlives the request: a timer, and an inject started but not awaited.
  instance.get("/api/test/detached", async (request) => {
    whoami(request);
    later.push(
      sleep(30).then(async () => {
        const res = await instance.inject({ method: "GET", url: "/api/test/whoami" });
        return { status: res.statusCode, body: res.json() };
      }),
    );
    later.push(
      instance
        .inject({ method: "GET", url: "/api/test/whoami" })
        .then((res) => ({ status: res.statusCode, body: res.json() })),
    );
    return { ok: true };
  });
  // Outbound HTTP: to our own listening server and to another server.
  instance.get("/api/test/outbound", async (request) => {
    whoami(request);
    const { selfPort, otherPort } = request.query as { selfPort: string; otherPort: string };
    const self = await fetch(`http://127.0.0.1:${selfPort}/api/test/whoami`);
    const other = await fetch(`http://127.0.0.1:${otherPort}/probe`);
    return { selfStatus: self.status, other: await other.json() };
  });

  await instance.ready();
  app = instance;
  return instance;
}

function startProbeServer(): Promise<number> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ authorizationHeader: req.headers.authorization ?? null }));
  });
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

const asDelegate = (instance: FastifyInstance, routeUrl: string, url = routeUrl, user = "u_1") =>
  injectAsDelegate(instance, { context: delegatedContext(user), method: "GET", routeUrl, url });

describe("delegated scope (VAY-2506)", () => {
  it("reaches the auth hook: the user's context, source agent, no session id", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/api/test/whoami");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: "u_1",
      source: "agent",
      sessionId: null,
      toolCallId: "tool_call_u_1",
    });
  });

  it("is never visible to an outside request, before, during or after", async () => {
    const instance = await buildTestApp();
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const port = (instance.server.address() as AddressInfo).port;
    const outside = () =>
      fetch(`http://127.0.0.1:${port}/api/test/whoami`, {
        headers: { "x-delegation": "u_1", "x-vayada-agent": "true", "x-tool-call-id": "t" },
      });
    expect((await outside()).status).toBe(401);
    const during = injectAsDelegate(instance, {
      context: delegatedContext("u_1"),
      method: "GET",
      routeUrl: "/api/test/slow/:ms",
      url: "/api/test/slow/40",
    });
    const [inside, concurrentOutside] = await Promise.all([during, outside()]);
    expect(inside.statusCode).toBe(200);
    expect(concurrentOutside.status).toBe(401);
    expect((await outside()).status).toBe(401);
    expect((await instance.inject({ method: "GET", url: "/api/test/whoami" })).statusCode).toBe(
      401,
    );
  });

  it("refuses a route the action did not declare, including a 404", async () => {
    const instance = await buildTestApp();
    const mismatch = await asDelegate(instance, "/api/test/whoami", "/api/test/other");
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toMatchObject({ code: "delegation_refused" });
    expect((await asDelegate(instance, "/api/test/whoami", "/api/test/missing")).statusCode).toBe(
      403,
    );
    const templated = await asDelegate(instance, "/api/test/slow/:ms", "/api/test/slow/1");
    expect(templated.statusCode).toBe(200);
  });

  it("refuses every route the gate does not allow, and everything without a gate", async () => {
    const onlyOther = await buildTestApp({
      gate: { allowsRoute: (method, url) => method === "GET" && url === "/api/test/other" },
    });
    expect((await asDelegate(onlyOther, "/api/test/whoami")).statusCode).toBe(403);
    expect((await asDelegate(onlyOther, "/api/test/other")).statusCode).toBe(200);
    await onlyOther.close();

    const noGate = await buildTestApp({ gate: null });
    const res = await asDelegate(noGate, "/api/test/whoami");
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not delegable");
  });

  it("refuses paths that never take user tokens", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/partner/v1/hotel");
    expect(res.statusCode).toBe(403);
  });

  it("refuses a delegated request that also carries a bearer token", async () => {
    const instance = await buildTestApp({ addBearerFirst: true });
    const res = await asDelegate(instance, "/api/test/whoami");
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("bearer token");
  });

  it("only takes GET, and only a narrowed agent context", async () => {
    const instance = await buildTestApp();
    const call = (context: RequestContext, method = "GET") =>
      injectAsDelegate(instance, {
        context,
        method: method as "GET",
        routeUrl: "/api/test/whoami",
        url: "/api/test/whoami",
      });
    await expect(call(delegatedContext("u_1"), "POST")).rejects.toThrow(DelegationRefusedError);

    const base = delegatedContext("u_1");
    const withSession: RequestContext = {
      ...base,
      actor: {
        ...base.actor,
        providerIdentity: { ...base.actor.providerIdentity, sessionId: "s" },
      },
    };
    const apiSource: RequestContext = { ...base, audit: { ...base.audit, source: "api" } };
    const platform: RequestContext = {
      ...base,
      selectedOrganization: { ...base.selectedOrganization, kind: "platform" },
    };
    const extraLink: RequestContext = {
      ...base,
      linkedResources: [
        ...base.linkedResources,
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "22222222-2222-4222-8222-222222222222",
          relationship: "owner",
          status: "active",
        },
      ],
    };
    const noDelegation: RequestContext = { ...base, delegation: undefined };
    for (const context of [withSession, apiSource, platform, extraLink, noDelegation]) {
      await expect(call(context)).rejects.toThrow(DelegationRefusedError);
    }
    await expect(
      injectAsDelegate(instance, {
        context: base,
        method: "GET",
        routeUrl: "/api/test/whoami",
        url: "//evil.example/api/test/whoami",
      }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  it("is one-shot: a raw inject from the handler is refused", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/api/test/nested-raw");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      innerStatus: 403,
      innerBody: { code: "delegation_refused", message: expect.stringContaining("already used") },
    });
  });

  it("refuses a second delegation started inside a delegated request", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/api/test/nested-delegate");
    expect(res.json()).toEqual({ refused: true });
  });

  it("refuses detached work: an unawaited inject and a timer after the request", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/api/test/detached");
    expect(res.statusCode).toBe(200);
    const [timer, unawaited] = await Promise.all(later);
    expect(timer).toMatchObject({
      status: 403,
      body: { message: expect.stringContaining("closed") },
    });
    expect(unawaited?.status).toBe(403);
  });

  it("never reaches an outbound HTTP request", async () => {
    const instance = await buildTestApp();
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const selfPort = (instance.server.address() as AddressInfo).port;
    const otherPort = await startProbeServer();
    const res = await asDelegate(
      instance,
      "/api/test/outbound",
      `/api/test/outbound?selfPort=${selfPort}&otherPort=${otherPort}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ selfStatus: 401, other: { authorizationHeader: null } });
    // The keep-alive socket opened inside the scope carries nothing into later calls.
    expect((await fetch(`http://127.0.0.1:${selfPort}/api/test/whoami`)).status).toBe(401);
  });

  it("keeps 200 concurrent delegations apart", async () => {
    const instance = await buildTestApp();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        asDelegate(instance, "/api/test/slow/:ms", `/api/test/slow/${i % 7}`, `u_${i}`).then(
          (res) => ({ i, status: res.statusCode, userId: res.json().userId }),
        ),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.userId).toBe(`u_${r.i}`);
    }
  });
});
