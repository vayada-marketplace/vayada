import { describe, expect, it } from "vitest";
import pg from "pg";

import type {
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  Product,
  ResourceRelationship,
  RequestContext,
  ResourceType,
} from "@vayada/backend-auth";

import {
  AuthorizationError,
  canAccessResource,
  createAuthorizationResolver,
  hasPermission,
  requirePermission,
  requireResourceAccess,
  createPgRolePermissionRepository,
  type ResourceAccessRequirement,
  type RolePermissionRepository,
} from "./index.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

function assertSafeTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(dbName)) {
    throw new Error(`Refusing to use non-test database "${dbName}"`);
  }
}

async function resetRolePermissionGrantsTable(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS identity`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS identity.role_permission_grants (
      organization_kind TEXT NOT NULL,
      role_key TEXT NOT NULL,
      permission_key TEXT NOT NULL
    )
  `);
  await client.query(`TRUNCATE TABLE identity.role_permission_grants RESTART IDENTITY CASCADE`);
}

function linkedResource(
  product: Product,
  resourceType: ResourceType,
  resourceId: string,
): LinkedResource {
  return {
    product,
    resourceType,
    resourceId,
    relationship: product === "platform" ? "operator" : "owner",
    status: "active",
  };
}

function contextFor(options: {
  kind: OrganizationKind;
  roleKey: string;
  permissions: PermissionKey[];
  linkedResources: LinkedResource[];
}): RequestContext {
  return {
    actor: {
      internalUserId: "user_test",
      providerIdentity: { provider: "workos", providerUserId: "user_workos_test" },
      email: "user@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId: "org_test",
      workosOrgId: "org_workos_test",
      kind: options.kind,
      status: "active",
    },
    membership: {
      membershipId: "membership_test",
      status: "active",
      roleKey: options.roleKey,
      workosMembershipId: "om_test",
      workosRoleSlugs: [options.roleKey],
      permissions: options.permissions,
    },
    linkedResources: options.linkedResources,
    entitlements: [],
    locale: "en-US",
    currency: "EUR",
    audit: {
      requestId: "req_test",
      source: "api",
      receivedAt: "2026-06-04T12:00:00.000Z",
    },
  };
}

const hotelContext = contextFor({
  kind: "hotel_group",
  roleKey: "hotel_owner",
  permissions: ["booking.settings.manage"],
  linkedResources: [linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose")],
});

const creatorContext = contextFor({
  kind: "creator_workspace",
  roleKey: "creator_owner",
  permissions: ["marketplace.profile.manage"],
  linkedResources: [linkedResource("marketplace", "creator_profile", "creator_profile_lina")],
});

const affiliateContext = contextFor({
  kind: "affiliate_partner",
  roleKey: "affiliate_owner",
  permissions: ["affiliate.payout.manage"],
  linkedResources: [linkedResource("affiliate", "affiliate", "affiliate_partner_bali")],
});

const platformContext = contextFor({
  kind: "platform",
  roleKey: "platform_admin",
  permissions: ["platform.user.suspend"],
  linkedResources: [linkedResource("platform", "platform", "vayada")],
});

function requirement(
  permission: PermissionKey,
  product: Product,
  resourceType: ResourceType,
  resourceId: string,
  allowedRelationships: readonly ResourceRelationship[] = ["owner"],
): ResourceAccessRequirement {
  return {
    permission,
    resource: { product, resourceType, resourceId, allowedRelationships },
  };
}

describe("createAuthorizationResolver", () => {
  it("loads permissions for the selected organization kind and role", async () => {
    const calls: Array<{ kind: OrganizationKind; roleKey: string }> = [];
    const repository: RolePermissionRepository = {
      async findPermissionsForRole(kind, roleKey) {
        calls.push({ kind, roleKey });
        return ["booking.settings.manage", "pms.booking.update"];
      },
    };

    const resolution = await createAuthorizationResolver(repository)(hotelContext);

    expect(calls).toEqual([{ kind: "hotel_group", roleKey: "hotel_owner" }]);
    expect(resolution.permissions).toEqual(["booking.settings.manage", "pms.booking.update"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("createPgRolePermissionRepository", () => {
  it("reads role grants from identity.role_permission_grants", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    try {
      await resetRolePermissionGrantsTable(client);
      await client.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES
           ('hotel_group', 'hotel_owner', 'booking.settings.manage'),
           ('hotel_group', 'hotel_owner', 'pms.booking.update'),
           ('creator_workspace', 'creator_owner', 'marketplace.profile.manage')`,
      );
    } finally {
      await client.end();
    }

    const repository = createPgRolePermissionRepository({
      connectionString: TEST_DATABASE_URL!,
      max: 1,
    });

    try {
      await expect(
        repository.findPermissionsForRole("hotel_group", "hotel_owner"),
      ).resolves.toEqual(["booking.settings.manage", "pms.booking.update"]);
      await expect(
        repository.findPermissionsForRole("platform", "platform_admin"),
      ).resolves.toEqual([]);
    } finally {
      await repository.close?.();
    }

    const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await cleanup.connect();
    try {
      await resetRolePermissionGrantsTable(cleanup);
    } finally {
      await cleanup.end();
    }
  });
});

describe("authorization helpers", () => {
  it.each([
    [
      "allows hotel owner with booking permission and booking hotel link",
      hotelContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      true,
    ],
    [
      "denies hotel owner when the resource relationship is not allowed",
      contextFor({
        kind: "hotel_group",
        roleKey: "hotel_owner",
        permissions: ["booking.settings.manage"],
        linkedResources: [
          {
            ...linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose"),
            relationship: "promotes",
          },
        ],
      }),
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      false,
    ],
    [
      "denies hotel owner when the booking hotel is not linked",
      hotelContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_other"),
      false,
    ],
    [
      "allows creator owner with profile permission and creator profile link",
      creatorContext,
      requirement(
        "marketplace.profile.manage",
        "marketplace",
        "creator_profile",
        "creator_profile_lina",
      ),
      true,
    ],
    [
      "denies creator owner without hotel collaboration permission",
      creatorContext,
      requirement(
        "marketplace.collaboration.review",
        "marketplace",
        "creator_profile",
        "creator_profile_lina",
      ),
      false,
    ],
    [
      "allows affiliate owner with payout permission and affiliate link",
      affiliateContext,
      requirement("affiliate.payout.manage", "affiliate", "affiliate", "affiliate_partner_bali"),
      true,
    ],
    [
      "denies affiliate owner without implicit hotel finance permission",
      affiliateContext,
      requirement("pms.finance.read", "pms", "pms_hotel", "pms_hotel_alpenrose"),
      false,
    ],
    [
      "allows platform admin with platform permission and platform link",
      platformContext,
      requirement("platform.user.suspend", "platform", "platform", "vayada", ["operator"]),
      true,
    ],
    [
      "denies platform admin as implicit hotel owner",
      platformContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      false,
    ],
  ] as const)("%s", (_name, context, accessRequirement, expected) => {
    expect(canAccessResource(context, accessRequirement)).toBe(expected);
  });

  it("checks a single permission", () => {
    expect(hasPermission(hotelContext, "booking.settings.manage")).toBe(true);
    expect(hasPermission(hotelContext, "pms.finance.read")).toBe(false);
  });

  it("throws authorization errors for missing permissions or resource access", () => {
    expect(() => requirePermission(hotelContext, "pms.finance.read")).toThrow(AuthorizationError);
    expect(() =>
      requireResourceAccess(
        hotelContext,
        requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_other"),
      ),
    ).toThrow(AuthorizationError);
  });
});
