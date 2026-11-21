// AI reads that run real next-api routes as the signed-in user (VAY-2506): the real buildApp(),
// the real route modules and policies, the real authorization resolver; only storage is faked.
import {
  createFakeVerifier,
  DelegationRefusedError,
  injectAsDelegate,
  resolveDelegatedContext,
  type IdentityRepository,
  type IdentityResourceLink,
  type PermissionKey,
  type RequestContext,
  type VerifiedSession,
} from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type MembershipPropertyScope,
  type PropertyAccessRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import type { PmsOperationsReadRepository } from "../domains/pmsOperationsReadModel.js";
import type { BookingPromoCodesRepository } from "../routes/bookingPromoCodes.js";
import type { PmsModuleActivationRepository } from "../routes/pmsModuleActivations.js";
import { fillRouteTemplate, runDelegatedRead } from "./delegatedRead.js";

const MEMBER = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const ORG_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PLATFORM = "bbbbbbbb-0000-4000-8000-0000000000ff";
const P1 = "cccccccc-0000-4000-8000-000000000001";
const P2 = "cccccccc-0000-4000-8000-000000000002";
const P3 = "cccccccc-0000-4000-8000-000000000003";
const CONVERSATION = "dddddddd-0000-4000-8000-000000000001";

const ROOMS = "/api/pms/properties/:propertyId/rooms";
const PROMOS = "/api/booking/hotels/:hotelId/promo-codes";
const MODULES = "/api/pms/properties/:propertyId/module-activations";
const DELEGABLE = new Set([ROOMS, PROMOS, MODULES]);

const propertyLinks = (id: string): IdentityResourceLink[] => [
  {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: id,
    relationship: "owner",
    status: "active",
  },
  {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: id,
    relationship: "owner",
    status: "active",
  },
  {
    product: "pms",
    resourceType: "pms_property",
    resourceId: id,
    relationship: "owner",
    status: "active",
  },
];
const orgs = {
  [ORG_A]: {
    organizationId: ORG_A,
    workosOrgId: "org_wos_a",
    name: "A",
    kind: "hotel_group" as const,
    status: "active" as const,
  },
  [ORG_B]: {
    organizationId: ORG_B,
    workosOrgId: "org_wos_b",
    name: "B",
    kind: "hotel_group" as const,
    status: "active" as const,
  },
  [PLATFORM]: {
    organizationId: PLATFORM,
    workosOrgId: "org_wos_p",
    name: "vayada",
    kind: "platform" as const,
    status: "active" as const,
  },
};
// The member is a hotel manager assigned to P1 in account A, and the owner of account B.
// The owner owns account A (all properties).
const memberships: Record<
  string,
  Record<string, { id: string; roleKey: string; mode: "all" | "assigned"; assigned: string[] }>
> = {
  [MEMBER]: {
    [ORG_A]: { id: "m_member_a", roleKey: "hotel_manager", mode: "assigned", assigned: [P1] },
    [ORG_B]: { id: "m_member_b", roleKey: "hotel_owner", mode: "all", assigned: [] },
    [PLATFORM]: { id: "m_member_p", roleKey: "platform_admin", mode: "all", assigned: [] },
  },
  [OWNER]: { [ORG_A]: { id: "m_owner_a", roleKey: "hotel_owner", mode: "all", assigned: [] } },
};
const links: Record<string, IdentityResourceLink[]> = {
  [ORG_A]: [...propertyLinks(P1), ...propertyLinks(P2)],
  [ORG_B]: propertyLinks(P3),
};
const users = {
  [MEMBER]: {
    userId: MEMBER,
    email: "member@example.test",
    status: "active" as const,
    workosUserId: "wos_member",
  },
  [OWNER]: {
    userId: OWNER,
    email: "owner@example.test",
    status: "active" as const,
    workosUserId: "wos_owner",
  },
};

const identity: IdentityRepository = {
  async findUserByProviderUserId(_provider, providerUserId) {
    return Object.values(users).find((u) => u.workosUserId === providerUserId) ?? null;
  },
  async findOrganizationByWorkosOrgId(workosOrgId) {
    return Object.values(orgs).find((o) => o.workosOrgId === workosOrgId) ?? null;
  },
  async findUserById(userId) {
    return users[userId as keyof typeof users] ?? null;
  },
  async findOrganizationById(organizationId) {
    return orgs[organizationId as keyof typeof orgs] ?? null;
  },
  async findActiveMembership(userId, organizationId) {
    const m = memberships[userId]?.[organizationId];
    return m
      ? {
          membershipId: m.id,
          status: "active",
          roleKey: m.roleKey,
          workosMembershipId: null,
          workosRoleSlugs: [],
        }
      : null;
  },
  async findLinkedResources(organizationId) {
    return links[organizationId] ?? [];
  },
};
const readKeys: PermissionKey[] = [
  "pms.room_status.read",
  "pms.operations.read",
  "booking.promos.read",
  "hotel_catalog.property_manifest.read",
];
const rolePermissions: RolePermissionRepository = {
  async findPermissionsForRole(kind) {
    return kind === "hotel_group" ? readKeys : ["platform.admin.read"];
  },
};
const entitlements: EntitlementRepository = {
  async findEntitlementsForContext() {
    return [
      { product: "pms", key: "property-management", status: "active" },
      { product: "booking", key: "booking-engine", status: "active" },
    ];
  },
};
const propertyAccess: PropertyAccessRepository = {
  async findMembershipPropertyScope(context): Promise<MembershipPropertyScope | null> {
    const m = Object.values(memberships)
      .flatMap((byOrg) => Object.values(byOrg))
      .find((candidate) => candidate.id === context.membership.membershipId);
    return m
      ? {
          mode: m.mode,
          roleKey: m.roleKey,
          accessOrigin: "agency",
          assignedPropertyIds: m.assigned,
          productAccess: { pms: true, booking: true },
        }
      : null;
  },
};
const authorizationResolver = createAuthorizationResolver(
  rolePermissions,
  entitlements,
  propertyAccess,
);

const pmsOperationsRepository = {
  async listRoomsByPropertyId(propertyId: string) {
    return {
      items: [{ roomId: `room_${propertyId}`, roomNumber: "101", status: "available", propertyId }],
    };
  },
} as unknown as PmsOperationsReadRepository;
const promoCodes = {
  async listPromoCodesByHotelId() {
    return [];
  },
} as unknown as BookingPromoCodesRepository;
const moduleActivations = {
  async list() {
    return [];
  },
} as unknown as PmsModuleActivationRepository;

// Bearer tokens for the website path (a browser session carries a session id).
const sessions = new Map<string, VerifiedSession>([
  [
    "member-a",
    {
      workosUserId: "wos_member",
      workosOrgId: "org_wos_a",
      sessionId: "sess_m",
      expiresAt: 4102444800,
    },
  ],
  [
    "owner-a",
    {
      workosUserId: "wos_owner",
      workosOrgId: "org_wos_a",
      sessionId: "sess_o",
      expiresAt: 4102444800,
    },
  ],
]);

let app: ReturnType<typeof buildApp>;
let toolCall = 0;

beforeAll(async () => {
  app = buildApp({
    logger: false,
    pmsOperationsRepository,
    bookingPromoCodesRepository: promoCodes,
    pmsModuleActivationRepository: moduleActivations,
    // Mounts the module list in owner mode: it needs an owner browser session (inventory A2).
    hotelSetupFeatureHubCommands: {
      async updateFinancials() {
        throw new Error("not used");
      },
    },
    auth: {
      verifier: createFakeVerifier(sessions),
      repository: identity,
      rolePermissionRepository: rolePermissions,
      entitlementRepository: entitlements,
      propertyAccessRepository: propertyAccess,
      delegation: { allowsRoute: (method, url) => method === "GET" && DELEGABLE.has(url) },
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

const as = (userId: string, organizationId: string): Promise<RequestContext> =>
  resolveDelegatedContext(
    identity,
    {
      userId,
      organizationId,
      delegation: {
        channel: "in_app",
        conversationId: CONVERSATION,
        toolCallId: `call_${++toolCall}`,
      },
    },
    { authorizationResolver },
  );
const bearer = (token: string, url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("runDelegatedRead (VAY-2506)", () => {
  it("runs a real route as the user and returns its answer", async () => {
    const result = await runDelegatedRead(app, {
      context: await as(MEMBER, ORG_A),
      routeUrl: ROOMS,
      params: { propertyId: P1 },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ propertyId: P1, items: [{ roomNumber: "101" }] });
  });

  it("refuses a property of the same account that the member is not assigned to", async () => {
    const context = await as(MEMBER, ORG_A);
    await expect(
      runDelegatedRead(app, { context, routeUrl: ROOMS, params: { propertyId: P2 } }),
    ).rejects.toThrow(DelegationRefusedError);
    // Without the runner's check, the route itself refuses too.
    const direct = await injectAsDelegate(app, {
      context,
      method: "GET",
      routeUrl: ROOMS,
      url: `/api/pms/properties/${P2}/rooms`,
    });
    expect(direct.statusCode).toBe(403);
  });

  it("closes the hotel-group-only check of org-wide routes for the AI (VAY-2567 1a)", async () => {
    // The website: since VAY-2574 the shared link check also checks the member's assigned
    // properties, so a manager assigned to P1 no longer reads P2's promo codes (it answered 200).
    expect((await bearer("member-a", `/api/booking/hotels/${P2}/promo-codes`)).statusCode).toBe(
      403,
    );
    expect((await bearer("member-a", `/api/booking/hotels/${P1}/promo-codes`)).statusCode).toBe(
      200,
    );
    // The AI acting for the same person: the narrowed context makes the same route refuse.
    const context = await as(MEMBER, ORG_A);
    const direct = await injectAsDelegate(app, {
      context,
      method: "GET",
      routeUrl: PROMOS,
      url: `/api/booking/hotels/${P2}/promo-codes`,
    });
    expect(direct.statusCode).toBe(403);
    await expect(
      runDelegatedRead(app, { context, routeUrl: PROMOS, params: { hotelId: P2 } }),
    ).rejects.toThrow(DelegationRefusedError);
    const own = await runDelegatedRead(app, { context, routeUrl: PROMOS, params: { hotelId: P1 } });
    expect(own).toEqual({ statusCode: 200, body: { promoCodes: [] } });
  });

  it("keeps a user's two hotel accounts apart", async () => {
    const inA = await as(MEMBER, ORG_A);
    const inB = await as(MEMBER, ORG_B);
    const p3FromA = await injectAsDelegate(app, {
      context: inA,
      method: "GET",
      routeUrl: ROOMS,
      url: `/api/pms/properties/${P3}/rooms`,
    });
    expect(p3FromA.statusCode).toBe(403);
    const p3FromB = await runDelegatedRead(app, {
      context: inB,
      routeUrl: ROOMS,
      params: { propertyId: P3 },
    });
    expect(p3FromB.statusCode).toBe(200);
    await expect(
      runDelegatedRead(app, { context: inB, routeUrl: ROOMS, params: { propertyId: P1 } }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  it("never passes an owner-session gate, even for the owner", async () => {
    // The owner in a browser session passes it.
    expect(
      (await bearer("owner-a", `/api/pms/properties/${P1}/module-activations`)).statusCode,
    ).toBe(200);
    const result = await runDelegatedRead(app, {
      context: await as(OWNER, ORG_A),
      routeUrl: MODULES,
      params: { propertyId: P1 },
    });
    // The route's own refusal: a refused delegation would have thrown instead.
    expect(result.statusCode).toBe(403);
    expect((result.body as { code?: string }).code).not.toBe("delegation_refused");
  });

  it("refuses a property id in the query string outside the member's scope", async () => {
    const context = await as(MEMBER, ORG_A);
    await expect(
      runDelegatedRead(app, {
        context,
        routeUrl: ROOMS,
        params: { propertyId: P1 },
        query: { propertyId: P2 },
      }),
    ).rejects.toThrow(DelegationRefusedError);
  });

  it("throws, not answers, when the auth hook refuses the delegation", async () => {
    await expect(
      runDelegatedRead(app, {
        context: await as(MEMBER, ORG_A),
        routeUrl: "/api/pms/properties/:propertyId/room-types",
        params: { propertyId: P1 },
      }),
    ).rejects.toThrow(/not delegable/);
  });

  it("refuses platform accounts", async () => {
    await expect(as(MEMBER, PLATFORM)).rejects.toThrow(DelegationRefusedError);
  });

  it("refuses a route outside the delegable list, and a template it was not given", async () => {
    const context = await as(MEMBER, ORG_A);
    const notListed = await injectAsDelegate(app, {
      context,
      method: "GET",
      routeUrl: "/api/pms/properties/:propertyId/room-types",
      url: `/api/pms/properties/${P1}/room-types`,
    });
    expect(notListed.statusCode).toBe(403);
    const mismatch = await injectAsDelegate(app, {
      context,
      method: "GET",
      routeUrl: ROOMS,
      url: `/api/booking/hotels/${P1}/promo-codes`,
    });
    expect(mismatch.statusCode).toBe(403);
    expect(notListed.json().code).toBe("delegation_refused");
    expect(mismatch.json().code).toBe("delegation_refused");
  });

  it("is never reached by an outside request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${P1}/rooms`,
      headers: { "x-delegation": MEMBER, "x-tool-call-id": "call_x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("fillRouteTemplate", () => {
  it("fills and encodes parameters", () => {
    expect(fillRouteTemplate("/api/x/:a/y/:b", { a: "1", b: "a/b?c" })).toBe(
      "/api/x/1/y/a%2Fb%3Fc",
    );
  });

  it.each([
    ["a missing parameter", "/api/x/:a", {}],
    ["an empty parameter", "/api/x/:a", { a: "" }],
    ["an extra parameter", "/api/x/:a", { a: "1", b: "2" }],
    ["a wildcard", "/api/x/*", {}],
    ["a relative template", "api/x", {}],
  ])("refuses %s", (_label, template, params) => {
    expect(() => fillRouteTemplate(template, params as Record<string, string>)).toThrow(
      DelegationRefusedError,
    );
  });
});
