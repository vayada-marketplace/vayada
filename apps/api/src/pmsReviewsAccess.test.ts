import {
  staffAccessPermissionKeys,
  staffRoleDefaultPermissions,
  type PermissionKey,
  type RequestContext,
} from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerPmsReviewRoutes, type PmsReviewRepository } from "./routes/pmsReviews.js";

// VAY-2575: reviews use the inbox keys, so front desk sees and answers them, on its own properties.
const propertyId = "85750000-0000-4000-8000-000000000001";
const otherPropertyId = "85750000-0000-4000-8000-000000000002";
const organizationId = "85750000-0000-4000-8000-000000000003";
const reviewId = "review-1";
const base = `/properties/${propertyId}`;

type Actor = { roleKey: string; permissions: readonly PermissionKey[] };
// The account admin holds the old broad keys and every staff key (0002 and 0109 grants).
const owner: Actor = {
  roleKey: "hotel_owner",
  permissions: ["pms.operations.read", "pms.operations.manage", ...staffAccessPermissionKeys],
};
const frontDesk: Actor = {
  roleKey: "front_desk",
  permissions: staffRoleDefaultPermissions.front_desk,
};
const housekeeping: Actor = {
  roleKey: "housekeeping",
  permissions: staffRoleDefaultPermissions.housekeeping,
};
const without = (actor: Actor, key: PermissionKey): Actor => ({
  ...actor,
  permissions: actor.permissions.filter((permission) => permission !== key),
});

type Route = {
  method: "GET" | "POST";
  url: string;
  key: "pms.inbox.read" | "pms.inbox.reply";
  payload?: unknown;
};
const routes: Route[] = [
  { method: "GET", url: `${base}/reviews`, key: "pms.inbox.read" },
  { method: "GET", url: `${base}/reviews/${reviewId}/reply`, key: "pms.inbox.read" },
  { method: "GET", url: `${base}/guest-reviews`, key: "pms.inbox.read" },
  { method: "GET", url: `${base}/guest-reviews/${reviewId}`, key: "pms.inbox.read" },
  {
    method: "POST",
    url: `${base}/reviews/${reviewId}/reply`,
    key: "pms.inbox.reply",
    payload: { text: "Thank you for staying with us." },
  },
  {
    method: "POST",
    url: `${base}/guest-reviews/${reviewId}`,
    key: "pms.inbox.reply",
    payload: {},
  },
];

describe("PMS reviews for front desk (VAY-2575)", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("gives front desk both inbox keys and housekeeping neither", () => {
    expect(frontDesk.permissions).toEqual(
      expect.arrayContaining(["pms.inbox.read", "pms.inbox.reply"]),
    );
    expect(housekeeping.permissions).not.toContain("pms.inbox.read");
    expect(housekeeping.permissions).not.toContain("pms.inbox.reply");
  });

  it.each(routes)("$method $url: the owner may", async (route) => {
    const calls: string[] = [];
    app = await testApp(owner, calls);
    expectAllowed(await send(app, route), route, calls);
  });

  it.each(routes)("$method $url: front desk may", async (route) => {
    const calls: string[] = [];
    app = await testApp(frontDesk, calls);
    expectAllowed(await send(app, route), route, calls);
  });

  it("lets a reader with only pms.inbox.read see reviews but not answer them", async () => {
    const reader: Actor = { roleKey: "hotel_custom", permissions: ["pms.inbox.read"] };
    for (const route of routes) {
      const calls: string[] = [];
      app = await testApp(reader, calls);
      const response = await send(app, route);
      if (route.key === "pms.inbox.read") expectAllowed(response, route, calls);
      else expect([route.url, response.statusCode]).toEqual([route.url, 403]);
      await app.close();
      app = undefined;
    }
  });

  it.each(routes)("$method $url: front desk without $key is refused", async (route) => {
    const calls: string[] = [];
    app = await testApp(without(frontDesk, route.key), calls);
    expect((await send(app, route)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(routes)("$method $url: housekeeping is refused", async (route) => {
    const calls: string[] = [];
    app = await testApp(housekeeping, calls);
    expect((await send(app, route)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(routes)(
    "$method $url: front desk assigned only to another property is refused",
    async (route) => {
      const calls: string[] = [];
      app = await testApp(frontDesk, calls, { assignedPropertyIds: [otherPropertyId] });
      expect((await send(app, route)).statusCode).toBe(403);
      expect(calls).toEqual([]);
    },
  );
});

/** Past every access check and handled: no 401, 403 or 5xx, and storage was reached (or the body
 * was refused, for the empty guest-review draft). */
function expectAllowed(
  response: { statusCode: number; body: string },
  route: Route,
  calls: string[],
) {
  expect(response.statusCode, response.body).toBeLessThan(500);
  expect([401, 403], response.body).not.toContain(response.statusCode);
  if (response.statusCode !== 400) expect(calls.length, route.url).toBeGreaterThan(0);
}

function send(target: Awaited<ReturnType<typeof testApp>>, route: Route) {
  return target.inject({
    method: route.method,
    url: route.url,
    headers: { authorization: "Bearer valid" },
    ...(route.payload === undefined ? {} : { payload: route.payload as object }),
  });
}

async function testApp(
  actor: Actor,
  calls: string[],
  scope: { assignedPropertyIds?: string[] } = {},
) {
  const record =
    <T>(name: string, result: T) =>
    async () => {
      calls.push(name);
      return result;
    };
  const repository = {
    list: record("list", { items: [], total: 0 }),
    replies: {
      check: record("replies.check", { state: "unavailable", reason: "connection_unavailable" }),
      submit: record("replies.submit", { state: "unavailable", reason: "connection_unavailable" }),
    },
    guestReviews: {
      list: record("guestReviews.list", { items: [], stored: [], more: false }),
      check: record("guestReviews.check", { reviewId, state: "unavailable" }),
      submit: record("guestReviews.submit", { reviewId, state: "unavailable" }),
    },
  } as unknown as PmsReviewRepository;

  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = {
      actor: { internalUserId: "85750000-0000-4000-8000-000000000004", status: "active" },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId: "85750000-0000-4000-8000-000000000005",
        roleKey: actor.roleKey,
        status: "active",
        permissions: [...actor.permissions],
        propertyAccess: {
          mode: scope.assignedPropertyIds ? "assigned" : "all",
          roleKey: actor.roleKey,
          accessOrigin: "agency",
          assignedPropertyIds: scope.assignedPropertyIds ?? [],
        },
      },
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
      ],
      linkedResources: [propertyId, otherPropertyId].flatMap((resourceId) =>
        [
          ["pms", "pms_property"],
          ["hotel_catalog", "property"],
        ].map(([product, resourceType]) => ({
          product,
          resourceType,
          resourceId,
          relationship: "owner",
          status: "active",
        })),
      ),
      audit: { requestId: "request-1", source: "api", receivedAt: "2026-11-21T10:00:00.000Z" },
    } as unknown as RequestContext;
  });
  await app.register(registerPmsReviewRoutes, {
    repository,
    propertyAccessRepository: {
      async findMembershipPropertyScope() {
        return null;
      },
    },
  });
  return app;
}
