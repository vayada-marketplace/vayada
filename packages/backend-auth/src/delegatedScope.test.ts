// The one-shot delegated scope through the real backend-auth onRequest hook (VAY-2506).
// Mechanism and the callback-form rule come from the VAY-2500 spike: if injectAsDelegate ever
// switched to the promise form of app.inject, the first test here would get a 401.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";

import { resolveDelegatedChangeContext, resolveDelegatedContext } from "./delegatedContext.js";
import {
  DELEGATED_BODY_MAX_BYTES,
  injectAsDelegate,
  type DelegatedMethod,
  type DelegatedRouteGate,
} from "./delegatedScope.js";
import { DelegationRefusedError } from "./errors.js";
import { backendAuthPlugin, requireAuthContext } from "./plugin.js";
import type { IdentityRepository } from "./repository.js";
import type { RequestContext } from "./types.js";
import { createFakeVerifier } from "./verify.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const ids = new Map<string, string>();
/** A stable UUID per test label ("u_1" -> uuid). */
const uid = (label: string) => ids.get(label) ?? ids.set(label, randomUUID()).get(label)!;

// Just enough identity for resolveDelegatedContext: every user owns the one property of ORG.
const mintingRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return null;
  },
  async findOrganizationByWorkosOrgId() {
    return null;
  },
  async findUserById(userId) {
    return {
      userId,
      email: `${userId}@example.test`,
      status: "active",
      workosUserId: `wos_${userId}`,
    };
  },
  async findOrganizationById(organizationId) {
    return {
      organizationId,
      workosOrgId: null,
      name: "Hotel",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership(userId) {
    return {
      membershipId: `m_${userId}`,
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: null,
      workosRoleSlugs: [],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: PROPERTY,
        relationship: "owner",
        status: "active",
      },
    ];
  },
};

/** A context exactly as the AI layer gets it: resolved per tool call by resolveDelegatedContext. */
function mint(
  label: string,
  options: { resolvedAt?: Date; access?: "read" | "change" } = {},
): Promise<RequestContext> {
  const resolver =
    options.access === "change" ? resolveDelegatedChangeContext : resolveDelegatedContext;
  return resolver(
    mintingRepository,
    {
      userId: uid(label),
      organizationId: ORG,
      delegation: {
        channel: "in_app",
        conversationId: CONVERSATION,
        toolCallId: `tool_call_${label}`,
      },
    },
    {
      authorizationResolver: async () => ({
        permissions: [],
        propertyAccess: {
          mode: "all",
          roleKey: "hotel_owner",
          accessOrigin: "agency",
          assignedPropertyIds: [],
        },
      }),
      ...(options.resolvedAt ? { now: () => options.resolvedAt! } : {}),
    },
  );
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
    access: ctx.delegation?.access ?? null,
    requestId: ctx.audit.requestId,
    correlationId: ctx.audit.correlationId ?? null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const allowAll: DelegatedRouteGate = { allowsRoute: () => true };

async function buildTestApp(
  options: {
    gate?: DelegatedRouteGate | null;
    addBearerFirst?: boolean;
    dropNonceFirst?: boolean;
  } = {},
) {
  const instance = Fastify({ logger: false });
  if (options.addBearerFirst) {
    // Runs before the auth hook: a delegated request must never also carry a bearer token.
    instance.addHook("onRequest", async (request) => {
      request.headers.authorization = "Bearer smuggled";
    });
  }
  if (options.dropNonceFirst) {
    // Stands for an outside request resumed inside an armed scope: it never has the nonce.
    instance.addHook("onRequest", async (request) => {
      delete request.headers["x-vayada-delegation-nonce"];
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
  // A route that changes its own context must not change the caller's.
  instance.get("/api/test/mutate", async (request) => {
    const ctx = requireAuthContext(request);
    ctx.membership.permissions.push("pms.operations.manage");
    ctx.actor.internalUserId = "changed";
    return { ok: true };
  });
  instance.post("/api/test/whoami", async (request) => whoami(request));
  // What a write route receives: its body, the one Idempotency-Key, and who it runs as.
  const echo = async (request: FastifyRequest) => ({
    ...whoami(request),
    method: request.method,
    body: request.body ?? null,
    contentType: request.headers["content-type"] ?? null,
    idempotencyKey: request.headers["idempotency-key"] ?? null,
    idempotencyKeyHeaders: request.raw.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
    ).length,
    nonce: request.headers["x-vayada-delegation-nonce"] ?? null,
  });
  instance.post("/api/test/echo", echo);
  instance.put("/api/test/echo", echo);
  instance.patch("/api/test/echo", echo);
  instance.delete("/api/test/echo", echo);
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
        context: await mint("u_nested"),
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

const asDelegate = async (
  instance: FastifyInstance,
  routeUrl: string,
  url = routeUrl,
  user = "u_1",
) => injectAsDelegate(instance, { context: await mint(user), method: "GET", routeUrl, url });

describe("delegated scope (VAY-2506)", () => {
  it("reaches the auth hook: the user's context, source agent, no session id", async () => {
    const instance = await buildTestApp();
    const res = await asDelegate(instance, "/api/test/whoami");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: uid("u_1"),
      source: "agent",
      sessionId: null,
      toolCallId: "tool_call_u_1",
      access: "read",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      correlationId: "tool_call_u_1",
    });
  });

  it("gives every request its own request id; the tool-call id is the correlation id", async () => {
    const instance = await buildTestApp();
    const context = await mint("u_1");
    const call = () =>
      injectAsDelegate(instance, {
        context,
        method: "GET",
        routeUrl: "/api/test/whoami",
        url: "/api/test/whoami",
      }).then((res) => res.json());
    const [first, second] = [await call(), await call()];
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).not.toBe(context.audit.requestId);
    expect([first.correlationId, second.correlationId]).toEqual(["tool_call_u_1", "tool_call_u_1"]);
  });

  it("takes the request id the action runner minted, and only a UUID (VAY-2508)", async () => {
    const instance = await buildTestApp();
    const context = await mint("u_1");
    const requestId = "25080000-0000-4000-8000-0000000000f1";
    const call = (id: string) =>
      injectAsDelegate(instance, {
        context,
        method: "GET",
        routeUrl: "/api/test/whoami",
        url: "/api/test/whoami",
        requestId: id,
      });
    expect((await (await call(requestId)).json()).requestId).toBe(requestId);
    await expect(call("tool_call_u_1")).rejects.toThrow(DelegationRefusedError);
  });

  it("is never visible to an outside request, before, during or after", async () => {
    const instance = await buildTestApp();
    await instance.listen({ port: 0, host: "127.0.0.1" });
    const port = (instance.server.address() as AddressInfo).port;
    const outside = () =>
      fetch(`http://127.0.0.1:${port}/api/test/whoami`, {
        headers: {
          "x-delegation": "u_1",
          "x-vayada-agent": "true",
          "x-tool-call-id": "t",
          "x-vayada-delegation-nonce": "AAAA",
        },
      });
    expect((await outside()).status).toBe(401);
    const during = injectAsDelegate(instance, {
      context: await mint("u_1"),
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

  it("refuses a request inside the scope that is not the one it was opened for", async () => {
    const instance = await buildTestApp({ dropNonceFirst: true });
    const res = await asDelegate(instance, "/api/test/whoami");
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not the request this scope was opened for");
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

  it("only takes a context resolveDelegatedContext returned, and only while fresh", async () => {
    const instance = await buildTestApp();
    const call = (context: RequestContext, method = "GET", url = "/api/test/whoami") =>
      injectAsDelegate(instance, {
        context,
        method: method as "GET",
        routeUrl: "/api/test/whoami",
        url,
      });
    const minted = await mint("u_1");
    expect((await call(minted)).statusCode).toBe(200);
    await expect(call(minted, "POST")).rejects.toThrow(/may only read/);
    await expect(call(minted, "OPTIONS")).rejects.toThrow(/unsupported method/);
    // A copy with exactly the same content was not minted, so it is refused (review M1).
    await expect(call(structuredClone(minted))).rejects.toThrow(/resolveDelegatedContext/);
    await expect(call({ ...minted })).rejects.toThrow(/resolveDelegatedContext/);
    // Resolved more than a minute ago: resolve it again per tool call.
    const stale = await mint("u_1", { resolvedAt: new Date(Date.now() - 61_000) });
    await expect(call(stale)).rejects.toThrow(/expired/);
    const future = await mint("u_1", { resolvedAt: new Date(Date.now() + 61_000) });
    await expect(call(future)).rejects.toThrow(/expired/);
    await expect(call(minted, "GET", "//evil.example/api/test/whoami")).rejects.toThrow(
      DelegationRefusedError,
    );
  });

  it("hands each request its own copy: minted contexts are frozen, route changes stay local", async () => {
    const instance = await buildTestApp();
    const minted = await mint("u_1");
    expect(() => {
      (minted.membership.permissions as string[]).push("pms.operations.manage");
    }).toThrow(TypeError);
    const res = await injectAsDelegate(instance, {
      context: minted,
      method: "GET",
      routeUrl: "/api/test/mutate",
      url: "/api/test/mutate",
    });
    expect(res.statusCode).toBe(200);
    expect(minted.membership.permissions).toEqual([]);
    expect(minted.actor.internalUserId).toBe(uid("u_1"));
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
      expect(r.userId).toBe(uid(`u_${r.i}`));
    }
  });
});

describe("write delegation (VAY-2522)", () => {
  const KEY = "op_2522-0001:1";
  const write = async (
    instance: FastifyInstance,
    options: {
      method?: DelegatedMethod;
      access?: "read" | "change";
      routeUrl?: string;
      url?: string;
      body?: unknown;
      idempotencyKey?: string | null;
    } = {},
  ) =>
    injectAsDelegate(instance, {
      context: await mint("u_1", { access: options.access ?? "change" }),
      method: options.method ?? "POST",
      routeUrl: options.routeUrl ?? "/api/test/echo",
      url: options.url ?? options.routeUrl ?? "/api/test/echo",
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.idempotencyKey === null ? {} : { idempotencyKey: options.idempotencyKey ?? KEY }),
    });

  it("refuses every write on a read delegation, before the route runs", async () => {
    const instance = await buildTestApp();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      await expect(write(instance, { method, access: "read" })).rejects.toThrow(/may only read/);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "runs a %s on a change delegation with its JSON body and exactly one Idempotency-Key",
    async (method) => {
      const instance = await buildTestApp();
      const res = await write(instance, { method, body: { note: "Late arrival", nights: 2 } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        userId: uid("u_1"),
        source: "agent",
        sessionId: null,
        access: "change",
        method,
        body: { note: "Late arrival", nights: 2 },
        contentType: "application/json",
        idempotencyKey: KEY,
        idempotencyKeyHeaders: 1,
        nonce: null,
      });
    },
  );

  it("sends no body and no content type when the change has none", async () => {
    const instance = await buildTestApp();
    const res = await write(instance, { method: "DELETE" });
    expect(res.json()).toMatchObject({ body: null, contentType: null, idempotencyKey: KEY });
  });

  it.each([
    ["no key", null],
    ["a key too short", "op_2522"],
    ["a key too long", "k".repeat(129)],
    ["a key with spaces", "op 2522 0001"],
    ["a key with a line break", "op_2522\r\nx-evil: 1"],
  ])("refuses a change with %s", async (_label, idempotencyKey) => {
    const instance = await buildTestApp();
    await expect(write(instance, { idempotencyKey })).rejects.toThrow(/Idempotency-Key/);
  });

  it("refuses a read that sends a body or an Idempotency-Key, also on a change delegation", async () => {
    const instance = await buildTestApp();
    const read = async (extra: { body?: unknown; idempotencyKey?: string }) =>
      injectAsDelegate(instance, {
        context: await mint("u_1", { access: "change" }),
        method: "GET",
        routeUrl: "/api/test/whoami",
        url: "/api/test/whoami",
        ...extra,
      });
    await expect(read({ body: {} })).rejects.toThrow(/no body/);
    await expect(read({ idempotencyKey: KEY })).rejects.toThrow(/no body/);
    expect((await read({})).json()).toMatchObject({ access: "change" });
  });

  it("takes Idempotency-Keys of 8 to 128 characters", async () => {
    const instance = await buildTestApp();
    for (const key of ["op_25221", "k".repeat(128)]) {
      expect((await write(instance, { idempotencyKey: key })).json().idempotencyKey).toBe(key);
    }
  });

  it("takes only a plain JSON object or array as the body", async () => {
    const instance = await buildTestApp();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const body of [
      cyclic,
      { n: BigInt(1) },
      () => 1,
      null,
      "text",
      42,
      new Map([["a", 1]]),
      new Date(0),
    ]) {
      await expect(write(instance, { body })).rejects.toThrow(/JSON object or array/);
    }
    expect((await write(instance, { body: [{ id: 1 }] })).json().body).toEqual([{ id: 1 }]);
  });

  it("counts the body's UTF-8 bytes, up to exactly the limit", async () => {
    const instance = await buildTestApp();
    // {"text":"…"} adds 11 bytes around the text.
    const ascii = (n: number) => ({ text: "x".repeat(n) });
    expect((await write(instance, { body: ascii(DELEGATED_BODY_MAX_BYTES - 11) })).statusCode).toBe(
      200,
    );
    await expect(write(instance, { body: ascii(DELEGATED_BODY_MAX_BYTES - 10) })).rejects.toThrow(
      /too large/,
    );
    // Fewer characters than the limit, but two bytes each.
    const accents = { text: "é".repeat(Math.ceil((DELEGATED_BODY_MAX_BYTES - 10) / 2)) };
    expect(JSON.stringify(accents).length).toBeLessThan(DELEGATED_BODY_MAX_BYTES);
    await expect(write(instance, { body: accents })).rejects.toThrow(/too large/);
  });

  it("reads its input once: a getter can't swap what was checked for what is sent", async () => {
    const instance = await buildTestApp();
    const readContext = await mint("u_1");
    const otherChange = await mint("u_other", { access: "change" });
    const reads = { context: 0, method: 0, idempotencyKey: 0 };
    const input = {
      routeUrl: "/api/test/echo",
      url: "/api/test/echo",
      get context() {
        return reads.context++ === 0 ? otherChange : readContext;
      },
      get method() {
        return reads.method++ === 0 ? ("POST" as const) : ("GET" as const);
      },
      get idempotencyKey() {
        return reads.idempotencyKey++ === 0 ? KEY : "bad key";
      },
    };
    const res = await injectAsDelegate(instance, input);
    expect(res.json()).toMatchObject({
      userId: uid("u_other"),
      access: "change",
      method: "POST",
      idempotencyKey: KEY,
    });
    expect(reads).toEqual({ context: 1, method: 1, idempotencyKey: 1 });
  });

  it("holds the same route rules as a read: declared route, method, gate", async () => {
    const instance = await buildTestApp({
      gate: { allowsRoute: (method, url) => method === "POST" && url === "/api/test/echo" },
    });
    expect((await write(instance)).statusCode).toBe(200);
    // Declared POST, sent to a route mounted only for GET: no route, refused by the hook.
    const getOnly = await write(instance, { routeUrl: "/api/test/other" });
    expect(getOnly.statusCode).toBe(403);
    // The gate allows POST only.
    const put = await write(instance, { method: "PUT" });
    expect(put.statusCode).toBe(403);
    expect(put.json().message).toContain("not delegable");
    // Declared one route, sent to another.
    const other = await write(instance, { routeUrl: "/api/test/echo", url: "/api/test/whoami" });
    expect(other.statusCode).toBe(403);
  });

  it("is one-shot for writes too: a raw write from inside the handler gets no user", async () => {
    const instance = Fastify({ logger: false });
    await instance.register(backendAuthPlugin, {
      verifier: createFakeVerifier(new Map()),
      repository: refusingRepository,
      delegation: allowAll,
    });
    instance.post("/api/test/outer", async () => {
      const inner = await instance.inject({ method: "POST", url: "/api/test/inner", payload: {} });
      return { innerStatus: inner.statusCode, innerCode: inner.json().code ?? null };
    });
    instance.post("/api/test/inner", async (request) => whoami(request));
    await instance.ready();
    app = instance;
    const res = await write(instance, { routeUrl: "/api/test/outer" });
    expect(res.json()).toEqual({ innerStatus: 403, innerCode: "delegation_refused" });
  });
});
