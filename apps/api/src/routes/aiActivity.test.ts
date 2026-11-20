import type { RequestSource } from "@vayada/backend-auth";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AiActivityItem, AiActivityQuery } from "../ai/actionLog/aiActivity.js";
import { registerAiActivityRoutes } from "./aiActivity.js";

const ORG = "25080000-0000-4000-8000-000000000001";
const OWNER = "25080000-0000-4000-8000-000000000002";
const STAFF = "25080000-0000-4000-8000-000000000003";
const PROPERTY = "25080000-0000-4000-8000-000000000004";

function item(n: number): AiActivityItem {
  return {
    id: `25080000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    occurredAt: `2026-11-20T10:00:0${n}.123456+00:00`,
    userId: STAFF,
    propertyId: PROPERTY,
    surface: "inbox_assist",
    client: "pms_inbox",
    action: "inbox_summarize",
    actionVersion: 1,
    group: "R2",
    arguments: { kind: "summarize" },
    recordsRead: [],
    recordsChanged: [],
    outcome: "ok",
    errorCode: null,
    sensitive: true,
    latencyMs: 10,
    requestId: `request-${n}`,
    correlationId: null,
    operationId: null,
  };
}

async function routeApp(
  options: {
    signedIn?: boolean;
    userId?: string;
    roleKey?: string;
    kind?: "hotel_group" | "platform";
    source?: RequestSource;
    rows?: AiActivityItem[];
  } = {},
) {
  const list = vi.fn(async (_: AiActivityQuery) => options.rows ?? []);
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (options.signedIn === false) return;
    request.authContext = {
      actor: {
        internalUserId: options.userId ?? STAFF,
        providerIdentity: { provider: "workos", providerUserId: "user_1" },
        email: "user@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId: ORG,
        kind: options.kind ?? "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: "25080000-0000-4000-8000-0000000000ff",
        status: "active",
        roleKey: options.roleKey ?? "front_desk",
        workosRoleSlugs: [],
        permissions: [],
      },
      linkedResources: [],
      entitlements: [],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "r",
        source: options.source ?? "api",
        receivedAt: "2026-11-20T10:00:00.000Z",
      },
    };
  });
  await app.register(registerAiActivityRoutes, { prefix: "/api/ai", store: { list } });
  return { app, list };
}

describe("GET /api/ai/activity", () => {
  it("shows a staff member only their own AI activity", async () => {
    const { app, list } = await routeApp({ rows: [item(1)] });
    const response = await app.inject({ method: "GET", url: "/api/ai/activity" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [item(1)], nextCursor: null });
    expect(list).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: STAFF,
      propertyId: undefined,
      before: undefined,
      limit: 51,
    });
    const other = await app.inject({ method: "GET", url: `/api/ai/activity?userId=${OWNER}` });
    expect(other.statusCode).toBe(403);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shows the account owner the whole account, or one user", async () => {
    const { app, list } = await routeApp({ userId: OWNER, roleKey: "hotel_owner" });
    await app.inject({ method: "GET", url: "/api/ai/activity" });
    await app.inject({
      method: "GET",
      url: `/api/ai/activity?userId=${STAFF}&propertyId=${PROPERTY}`,
    });
    expect(list.mock.calls.map(([query]) => [query.userId, query.propertyId])).toEqual([
      [undefined, undefined],
      [STAFF, PROPERTY],
    ]);
  });

  it("pages newest first with an opaque cursor", async () => {
    const { app, list } = await routeApp({ rows: [item(3), item(2), item(1)] });
    const first = await app.inject({ method: "GET", url: "/api/ai/activity?limit=2" });
    const body = first.json() as { items: AiActivityItem[]; nextCursor: string };
    expect(body.items.map((row) => row.requestId)).toEqual(["request-3", "request-2"]);
    await app.inject({ method: "GET", url: `/api/ai/activity?limit=2&cursor=${body.nextCursor}` });
    expect(list.mock.calls[1]![0].before).toEqual({
      occurredAt: item(2).occurredAt,
      id: item(2).id,
    });
  });

  it("refuses AI (delegated) contexts, platform accounts and signed-out requests", async () => {
    for (const options of [{ source: "agent" as const }, { kind: "platform" as const }]) {
      const { app, list } = await routeApp({ ...options, roleKey: "hotel_owner" });
      expect((await app.inject({ method: "GET", url: "/api/ai/activity" })).statusCode).toBe(403);
      expect(list).not.toHaveBeenCalled();
    }
    const { app } = await routeApp({ signedIn: false });
    expect((await app.inject({ method: "GET", url: "/api/ai/activity" })).statusCode).toBe(401);
  });

  it("rejects bad limits, ids and cursors", async () => {
    const { app, list } = await routeApp();
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=abc",
      "propertyId=x",
      "userId=x",
      "cursor=nope",
    ])
      expect(
        (await app.inject({ method: "GET", url: `/api/ai/activity?${query}` })).statusCode,
      ).toBe(422);
    expect(list).not.toHaveBeenCalled();
  });
});
