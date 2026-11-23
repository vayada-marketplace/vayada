// Resolving and narrowing the context of an AI tool call that acts as a user (VAY-2506).
import { describe, expect, it } from "vitest";

import {
  authorityNarrowing,
  delegatedPropertyIds,
  isDelegatedContext,
  isMintedDelegatedContext,
  narrowDelegatedContext,
  narrowingAllowsChange,
  resolveDelegatedChangeContext,
  resolveDelegatedContext,
  type AuthorityNarrowing,
  type DelegatedContextInput,
} from "./delegatedContext.js";
import { AuthError, DelegationRefusedError } from "./errors.js";
import type {
  IdentityMembership,
  IdentityOrganization,
  IdentityRepository,
  IdentityResourceLink,
  IdentityUserWithWorkosIdentity,
} from "./repository.js";
import type { AuthorizationResolver } from "./resolve.js";
import type { MembershipPropertyAccess, ProductEntitlement, RequestContext } from "./types.js";

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PLATFORM = "bbbbbbbb-0000-4000-8000-0000000000ff";
const P1 = "cccccccc-0000-4000-8000-000000000001";
const P2 = "cccccccc-0000-4000-8000-000000000002";
const P3 = "cccccccc-0000-4000-8000-000000000003";
const CONVERSATION = "dddddddd-0000-4000-8000-000000000001";

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

type Fixture = {
  user?: IdentityUserWithWorkosIdentity | null;
  orgs?: Record<string, IdentityOrganization>;
  memberships?: Record<string, IdentityMembership>;
  links?: Record<string, IdentityResourceLink[]>;
  byIdLookups?: boolean;
};

function repository(fixture: Fixture = {}): IdentityRepository {
  const user =
    fixture.user === undefined
      ? {
          userId: USER,
          email: "member@example.test",
          name: "Member",
          status: "active" as const,
          workosUserId: "user_wos_member",
        }
      : fixture.user;
  const orgs = fixture.orgs ?? {
    [ORG_A]: {
      organizationId: ORG_A,
      workosOrgId: "org_wos_a",
      name: "A",
      kind: "hotel_group",
      status: "active",
    },
    [ORG_B]: {
      organizationId: ORG_B,
      workosOrgId: "org_wos_b",
      name: "B",
      kind: "hotel_group",
      status: "active",
    },
    [PLATFORM]: {
      organizationId: PLATFORM,
      workosOrgId: "org_wos_p",
      name: "vayada",
      kind: "platform",
      status: "active",
    },
  };
  const memberships = fixture.memberships ?? {
    [ORG_A]: {
      membershipId: "m_a",
      status: "active",
      roleKey: "front_desk",
      workosMembershipId: null,
      workosRoleSlugs: [],
    },
    [ORG_B]: {
      membershipId: "m_b",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: null,
      workosRoleSlugs: [],
    },
    [PLATFORM]: {
      membershipId: "m_p",
      status: "active",
      roleKey: "platform_admin",
      workosMembershipId: null,
      workosRoleSlugs: [],
    },
  };
  const links = fixture.links ?? {
    [ORG_A]: [
      ...propertyLinks(P1),
      ...propertyLinks(P2),
      {
        product: "platform",
        resourceType: "payout_account",
        resourceId: "acct_1",
        relationship: "billing_account",
        status: "active",
      },
    ],
    [ORG_B]: propertyLinks(P3),
  };
  const base: IdentityRepository = {
    async findUserByProviderUserId() {
      throw new Error("not used by delegation");
    },
    async findOrganizationByWorkosOrgId() {
      throw new Error("not used by delegation");
    },
    async findActiveMembership(userId, organizationId) {
      return userId === user?.userId ? (memberships[organizationId] ?? null) : null;
    },
    async findLinkedResources(organizationId) {
      return links[organizationId] ?? [];
    },
  };
  if (fixture.byIdLookups === false) return base;
  return {
    ...base,
    async findUserById(userId) {
      return userId === user?.userId ? user : null;
    },
    async findOrganizationById(organizationId) {
      return orgs[organizationId] ?? null;
    },
  };
}

// Shaped like backend-authorization's resolver: org A's member is assigned P1 only.
const scopes: Record<string, MembershipPropertyAccess> = {
  m_a: {
    mode: "assigned",
    roleKey: "front_desk",
    accessOrigin: "agency",
    assignedPropertyIds: [P1],
  },
  m_b: { mode: "all", roleKey: "hotel_owner", accessOrigin: "agency", assignedPropertyIds: [] },
};
const entitlementsFor = (orgId: string): ProductEntitlement[] =>
  orgId === ORG_A
    ? [
        { product: "pms", key: "property-management", status: "active" },
        {
          product: "booking",
          key: "booking-engine",
          status: "active",
          resource: { product: "booking", resourceType: "booking_hotel", resourceId: P1 },
        },
        {
          product: "booking",
          key: "booking-engine",
          status: "active",
          resource: { product: "booking", resourceType: "booking_hotel", resourceId: P2 },
        },
        {
          product: "pms",
          key: "module:financials",
          status: "suspended",
          resource: { product: "pms", resourceType: "pms_property", resourceId: P2 },
        },
      ]
    : [{ product: "pms", key: "property-management", status: "active" }];
const authorizationResolver: AuthorizationResolver = async (context) => {
  const access = scopes[context.membership.membershipId];
  return {
    permissions: ["pms.reservation.read", "pms.calendar.read"],
    entitlements: entitlementsFor(context.selectedOrganization.organizationId),
    ...(access ? { propertyAccess: access } : {}),
  };
};

const input = (overrides: Partial<DelegatedContextInput> = {}): DelegatedContextInput => ({
  userId: USER,
  organizationId: ORG_A,
  delegation: { channel: "in_app", conversationId: CONVERSATION, toolCallId: "call_1" },
  ...overrides,
});
const resolve = (overrides: Partial<DelegatedContextInput> = {}, fixture?: Fixture) =>
  resolveDelegatedContext(repository(fixture), input(overrides), {
    authorizationResolver,
    now: () => new Date("2026-11-20T12:00:00Z"),
  });
const ids = (context: { linkedResources: { resourceType: string; resourceId: string }[] }) =>
  context.linkedResources.map((r) => `${r.resourceType}:${r.resourceId}`).sort();

describe("resolveDelegatedContext (VAY-2506)", () => {
  it("builds an agent context: tool-call ids, no session id, the user's own permissions", async () => {
    const context = await resolve();
    expect(context.audit).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      correlationId: "call_1",
      source: "agent",
      receivedAt: "2026-11-20T12:00:00.000Z",
    });
    expect(context.actor.providerIdentity).toEqual({
      provider: "workos",
      providerUserId: "user_wos_member",
      providerOrganizationId: "org_wos_a",
    });
    expect(context.actor.providerIdentity.sessionId).toBeUndefined();
    expect(context.delegation).toEqual({
      channel: "in_app",
      conversationId: CONVERSATION,
      toolCallId: "call_1",
      access: "read",
    });
    expect(context.membership.permissions).toEqual(["pms.reservation.read", "pms.calendar.read"]);
    expect(isDelegatedContext(context)).toBe(true);
  });

  it("keeps only the member's assigned properties and drops every other link (VAY-2567 1a)", async () => {
    const context = await resolve();
    expect(ids(context)).toEqual([`booking_hotel:${P1}`, `pms_property:${P1}`, `property:${P1}`]);
    expect(delegatedPropertyIds(context)).toEqual([P1]);
  });

  it("drops active entitlements tied to other properties but keeps suspensions and org-wide ones", async () => {
    const context = await resolve();
    expect(context.entitlements).toEqual([
      { product: "pms", key: "property-management", status: "active" },
      {
        product: "booking",
        key: "booking-engine",
        status: "active",
        resource: { product: "booking", resourceType: "booking_hotel", resourceId: P1 },
      },
      {
        product: "pms",
        key: "module:financials",
        status: "suspended",
        resource: { product: "pms", resourceType: "pms_property", resourceId: P2 },
      },
    ]);
  });

  it("separates the two hotel accounts of one user", async () => {
    const a = await resolve();
    const b = await resolve({ organizationId: ORG_B });
    expect(delegatedPropertyIds(a)).toEqual([P1]);
    expect(delegatedPropertyIds(b)).toEqual([P3]);
    expect(b.membership.roleKey).toBe("hotel_owner");
    expect(a.membership.roleKey).toBe("front_desk");
  });

  it("can narrow to fewer properties, never add one", async () => {
    const owner = await resolve({ organizationId: ORG_B, propertyIds: [P3, P1] });
    expect(delegatedPropertyIds(owner)).toEqual([P3]);
    expect(owner.membership.propertyAccess).toMatchObject({
      mode: "assigned",
      assignedPropertyIds: [P3],
    });

    const none = await resolve({ organizationId: ORG_B, propertyIds: [] });
    expect(none.linkedResources).toEqual([]);
    expect(isDelegatedContext(none)).toBe(true);

    const notMine = await resolve({ propertyIds: [P2] });
    expect(notMine.linkedResources).toEqual([]);
  });

  it("refuses platform accounts", async () => {
    await expect(resolve({ organizationId: PLATFORM })).rejects.toThrow(DelegationRefusedError);
  });

  it.each([
    ["an unknown user", { user: null }, "USER_NOT_FOUND"],
    [
      "a user without a WorkOS identity",
      {
        user: {
          userId: USER,
          email: "x@example.test",
          status: "active" as const,
          workosUserId: null,
        },
      },
      "USER_NOT_FOUND",
    ],
    [
      "a pending user",
      {
        user: {
          userId: USER,
          email: "x@example.test",
          status: "pending" as const,
          workosUserId: "w",
        },
      },
      "USER_SUSPENDED",
    ],
    [
      "a suspended account",
      {
        orgs: {
          [ORG_A]: {
            organizationId: ORG_A,
            workosOrgId: null,
            kind: "hotel_group" as const,
            status: "suspended" as const,
          },
        },
      },
      "ORGANIZATION_SUSPENDED",
    ],
    ["no membership", { memberships: {} }, "MEMBERSHIP_NOT_FOUND"],
    [
      "an inactive membership",
      {
        memberships: {
          [ORG_A]: {
            membershipId: "m_a",
            status: "inactive" as const,
            roleKey: "front_desk",
            workosMembershipId: null,
            workosRoleSlugs: [],
          },
        },
      },
      "MEMBERSHIP_NOT_FOUND",
    ],
  ])("refuses %s", async (_label, fixture, code) => {
    const error = await resolve({}, fixture).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
  });

  it("refuses an unknown account", async () => {
    const error = await resolve({ organizationId: "bbbbbbbb-0000-4000-8000-000000000999" }).catch(
      (e: unknown) => e,
    );
    expect((error as AuthError).code).toBe("ORGANIZATION_NOT_FOUND");
  });

  it.each([
    ["a malformed user id", { userId: "u1" }],
    ["a malformed account id", { organizationId: "org" }],
    [
      "a malformed tool-call id",
      {
        delegation: { channel: "in_app" as const, conversationId: CONVERSATION, toolCallId: "a b" },
      },
    ],
    [
      "a tool-call id longer than the AI action log keeps",
      {
        delegation: {
          channel: "in_app" as const,
          conversationId: CONVERSATION,
          toolCallId: "c".repeat(129),
        },
      },
    ],
    [
      "MCP without a connection",
      { delegation: { channel: "mcp" as const, conversationId: CONVERSATION, toolCallId: "c" } },
    ],
    [
      "both a connection and a conversation",
      {
        delegation: {
          channel: "in_app" as const,
          conversationId: CONVERSATION,
          connectionId: CONVERSATION,
          toolCallId: "c",
        },
      },
    ],
    ["a malformed property id", { propertyIds: ["p1"] }],
    ["a malformed locale", { locale: "en; drop" }],
    ["a malformed currency", { currency: "usd" }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(resolve(overrides)).rejects.toThrow(DelegationRefusedError);
  });

  it("never takes its access from the caller (VAY-2522)", async () => {
    const smuggled = {
      delegation: { ...input().delegation, access: "change" },
    } as unknown as Partial<DelegatedContextInput>;
    await expect(resolve(smuggled)).rejects.toThrow(/may not set access/);
    await expect(
      resolveDelegatedChangeContext(repository(), input(smuggled), { authorizationResolver }),
    ).rejects.toThrow(/may not set access/);
  });

  it("reads its input once: a getter can't add access or change the call after the checks", async () => {
    let reads = 0;
    const given = {
      ...input(),
      get delegation() {
        reads += 1;
        return reads === 1
          ? { channel: "in_app" as const, conversationId: CONVERSATION, toolCallId: "call_1" }
          : ({
              channel: "mcp",
              connectionId: CONVERSATION,
              toolCallId: "x",
              access: "change",
            } as never);
      },
    };
    const context = await resolveDelegatedContext(repository(), given, { authorizationResolver });
    expect(reads).toBe(1);
    expect(context.delegation).toEqual({
      channel: "in_app",
      conversationId: CONVERSATION,
      toolCallId: "call_1",
      access: "read",
    });
  });

  it.each([
    ["no delegation", { delegation: undefined }],
    ["a delegation that is not an object", { delegation: "in_app" }],
    ["a missing tool-call id", { delegation: { channel: "in_app", conversationId: CONVERSATION } }],
    // RegExp.test calls toString: an object that says it is a UUID is not one (review N1).
    ["a user id that only says it is a UUID", { userId: { toString: (): string => USER } }],
    [
      "a conversation id that only says it is a UUID",
      {
        delegation: {
          channel: "in_app",
          conversationId: { toString: (): string => CONVERSATION },
          toolCallId: "c",
        },
      },
    ],
    ["a locale that only says it is one", { locale: { toString: (): string => "en" } }],
  ])("refuses %s", async (_label, overrides) => {
    await expect(resolve(overrides as never)).rejects.toThrow(DelegationRefusedError);
  });

  it("needs the by-id lookups", async () => {
    await expect(resolve({}, { byIdLookups: false })).rejects.toThrow(/cannot resolve/);
  });

  it("gives no property at all when the authorization resolver refused the scope", async () => {
    const context = await resolveDelegatedContext(repository(), input(), {
      authorizationResolver: async () => ({ permissions: [], entitlements: [] }),
    });
    expect(context.linkedResources).toEqual([]);
    expect(context.membership.permissions).toEqual([]);
  });
});

describe("resolveDelegatedChangeContext (VAY-2522)", () => {
  it("is the same narrowed context with change access, minted like a read one", async () => {
    const read = await resolve();
    const change = await resolveDelegatedChangeContext(repository(), input(), {
      authorizationResolver,
      now: () => new Date("2026-11-20T12:00:00Z"),
    });
    expect(change.delegation?.access).toBe("change");
    const { delegation: readDelegation, audit: readAudit, ...readRest } = read;
    const { delegation: changeDelegation, audit: changeAudit, ...changeRest } = change;
    expect(changeRest).toEqual(readRest);
    expect({ ...changeDelegation, access: "read" }).toEqual(readDelegation);
    expect({ ...changeAudit, requestId: readAudit.requestId }).toEqual(readAudit);
    expect(isDelegatedContext(change)).toBe(true);
    expect(isMintedDelegatedContext(change)).toBe(true);
    expect(Object.isFrozen(change.delegation)).toBe(true);
  });
});

describe("minted delegated contexts", () => {
  it("are frozen and recognised; copies and hand-built variants are not", async () => {
    const context = await resolve();
    expect(isMintedDelegatedContext(context)).toBe(true);
    expect(Object.isFrozen(context.linkedResources[0])).toBe(true);
    expect(isMintedDelegatedContext(structuredClone(context))).toBe(false);
    expect(isMintedDelegatedContext(narrowDelegatedContext(context))).toBe(false);
  });

  it("isDelegatedContext refuses session ids, other sources, platform accounts and extra links", async () => {
    const base = await resolve();
    const variants = [
      {
        ...base,
        actor: {
          ...base.actor,
          providerIdentity: { ...base.actor.providerIdentity, sessionId: "s" },
        },
      },
      { ...base, audit: { ...base.audit, source: "api" as const } },
      { ...base, audit: { ...base.audit, correlationId: "another_call" } },
      {
        ...base,
        selectedOrganization: { ...base.selectedOrganization, kind: "platform" as const },
      },
      {
        ...base,
        linkedResources: [
          ...base.linkedResources,
          {
            product: "booking" as const,
            resourceType: "booking_hotel" as const,
            resourceId: P2,
            relationship: "owner" as const,
            status: "active" as const,
          },
        ],
      },
      { ...base, delegation: undefined },
      { ...base, delegation: { ...base.delegation!, access: "write" as "change" } },
      { ...base, delegation: { ...base.delegation!, access: undefined as unknown as "read" } },
    ];
    expect(isDelegatedContext(base)).toBe(true);
    for (const variant of variants) expect(isDelegatedContext(variant)).toBe(false);
  });
});

describe("narrowDelegatedContext", () => {
  it("is idempotent", async () => {
    const context = await resolve();
    expect(narrowDelegatedContext(context)).toEqual(context);
  });
});

describe("authorityNarrowing (VAY-2522)", () => {
  const change = (overrides: Partial<DelegatedContextInput> = {}) =>
    resolveDelegatedChangeContext(repository(), input(overrides), {
      authorizationResolver,
      now: () => new Date("2026-11-20T12:00:00Z"),
    });

  it("is null for a request a person made", async () => {
    const person: RequestContext = { ...(await resolve()) };
    delete person.delegation;
    expect(authorityNarrowing(person)).toBeNull();
  });

  it("carries the delegation's access and only the properties it may use", async () => {
    // Org A's member is assigned P1 only; org B's owner has all of B (P3).
    expect(authorityNarrowing(await resolve())).toEqual({ access: "read", propertyIds: [P1] });
    expect(authorityNarrowing(await change({ organizationId: ORG_B }))).toEqual({
      access: "change",
      propertyIds: [P3],
    });
    expect(authorityNarrowing(await change({ organizationId: ORG_B, propertyIds: [] }))).toEqual({
      access: "change",
      propertyIds: [],
    });
  });

  it("lets a change through only for a change narrowing that lists the property", async () => {
    const narrowing = authorityNarrowing(await change({ organizationId: ORG_B }));
    expect(narrowingAllowsChange(narrowing, P3)).toBe(true);
    expect(narrowingAllowsChange(narrowing, P3.toUpperCase())).toBe(true);
    expect(narrowingAllowsChange(narrowing, P1)).toBe(false);
    expect(narrowingAllowsChange(authorityNarrowing(await resolve()), P1)).toBe(false);
    expect(narrowingAllowsChange({ access: "change", propertyIds: [] }, P1)).toBe(false);
  });

  it("lets a person's request through: the route and the database decide", () => {
    expect(narrowingAllowsChange(null, P1)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["not an object", "change"],
    ["no access", { propertyIds: [P1] }],
    ["another access", { access: "CHANGE", propertyIds: [P1] }],
    ["no property list", { access: "change" }],
    // A string would match any substring of itself.
    ["a string for the list", { access: "change", propertyIds: P1 }],
    [
      "an object that prints the id",
      { access: "change", propertyIds: [{ toString: (): string => P1 }] },
    ],
  ])("refuses a malformed narrowing: %s", (_name, narrowing) => {
    expect(narrowingAllowsChange(narrowing as unknown as AuthorityNarrowing, P1)).toBe(false);
  });

  it("refuses a property id that is not a string", () => {
    const narrowing: AuthorityNarrowing = { access: "change", propertyIds: [P1] };
    expect(
      narrowingAllowsChange(narrowing, { toString: (): string => P1 } as unknown as string),
    ).toBe(false);
  });
});
