// A small world for the generated AI action safety tests (VAY-2507): two hotel accounts, three
// properties, three people. Identity, roles, entitlements and property scope are faked in memory;
// the authorization resolver, the auth plugin and every route are the real ones.
//
//   account A: P1, P2. OWNER owns all of A. MEMBER is a hotel manager assigned to P1 only.
//   account B: P3.     OTHER owns all of B.
import {
  createFakeVerifier,
  resolveDelegatedContext,
  type IdentityRepository,
  type IdentityResourceLink,
  type PermissionKey,
  type RequestContext,
} from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type MembershipPropertyScope,
  type PropertyAccessRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";

export const WORLD = {
  OWNER: "aaaaaaaa-0000-4000-8000-0000000000a1",
  MEMBER: "aaaaaaaa-0000-4000-8000-0000000000a2",
  OTHER: "aaaaaaaa-0000-4000-8000-0000000000b1",
  ORG_A: "bbbbbbbb-0000-4000-8000-00000000000a",
  ORG_B: "bbbbbbbb-0000-4000-8000-00000000000b",
  P1: "cccccccc-0000-4000-8000-000000000001",
  P2: "cccccccc-0000-4000-8000-000000000002",
  P3: "cccccccc-0000-4000-8000-000000000003",
  CONVERSATION: "dddddddd-0000-4000-8000-000000000001",
} as const;

/** Values every fixture plants in the fields an action must drop. */
export const FORBIDDEN = "FORBIDDEN-must-not-leave";

const { OWNER, MEMBER, OTHER, ORG_A, ORG_B, P1, P2, P3 } = WORLD;

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
};
const memberships: Record<
  string,
  Record<string, { id: string; roleKey: string; mode: "all" | "assigned"; assigned: string[] }>
> = {
  [OWNER]: { [ORG_A]: { id: "m_owner_a", roleKey: "hotel_owner", mode: "all", assigned: [] } },
  [MEMBER]: {
    [ORG_A]: { id: "m_member_a", roleKey: "hotel_manager", mode: "assigned", assigned: [P1] },
  },
  [OTHER]: { [ORG_B]: { id: "m_other_b", roleKey: "hotel_owner", mode: "all", assigned: [] } },
};
const links: Record<string, IdentityResourceLink[]> = {
  [ORG_A]: [...propertyLinks(P1), ...propertyLinks(P2)],
  [ORG_B]: propertyLinks(P3),
};
const users = Object.fromEntries(
  [OWNER, MEMBER, OTHER].map((userId) => [
    userId,
    {
      userId,
      email: `${userId}@example.test`,
      status: "active" as const,
      workosUserId: `wos_${userId}`,
    },
  ]),
);

export const worldIdentity: IdentityRepository = {
  async findUserByProviderUserId(_provider, providerUserId) {
    return Object.values(users).find((user) => user.workosUserId === providerUserId) ?? null;
  },
  async findOrganizationByWorkosOrgId(workosOrgId) {
    return Object.values(orgs).find((org) => org.workosOrgId === workosOrgId) ?? null;
  },
  async findUserById(userId) {
    return users[userId] ?? null;
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

/** The authorization side of the world, granting every role the given keys. */
export function worldAuthorization(permissions: readonly PermissionKey[]) {
  const rolePermissionRepository: RolePermissionRepository = {
    async findPermissionsForRole(kind) {
      return kind === "hotel_group" ? [...permissions] : [];
    },
  };
  const entitlementRepository: EntitlementRepository = {
    async findEntitlementsForContext() {
      return [
        { product: "pms", key: "property-management", status: "active" },
        { product: "pms", key: "module:financials", status: "active" },
        { product: "booking", key: "booking-engine", status: "active" },
      ];
    },
  };
  const propertyAccessRepository: PropertyAccessRepository = {
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
  return {
    auth: {
      verifier: createFakeVerifier(new Map()),
      repository: worldIdentity,
      rolePermissionRepository,
      entitlementRepository,
      propertyAccessRepository,
    },
    resolver: createAuthorizationResolver(
      rolePermissionRepository,
      entitlementRepository,
      propertyAccessRepository,
    ),
  };
}

let toolCalls = 0;

/** The delegated context of `userId` in `organizationId`, resolved like a real tool call. */
export async function worldContext(
  userId: string,
  organizationId: string,
  permissions: readonly PermissionKey[],
  channel: "in_app" | "mcp" = "in_app",
): Promise<RequestContext> {
  return resolveDelegatedContext(
    worldIdentity,
    {
      userId,
      organizationId,
      delegation:
        channel === "mcp"
          ? { channel, connectionId: WORLD.CONVERSATION, toolCallId: `call_${++toolCalls}` }
          : { channel, conversationId: WORLD.CONVERSATION, toolCallId: `call_${++toolCalls}` },
    },
    { authorizationResolver: worldAuthorization(permissions).resolver },
  );
}
