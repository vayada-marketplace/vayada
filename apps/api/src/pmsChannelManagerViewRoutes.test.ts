import {
  createFakeVerifier,
  staffAccessPermissionKeys,
  type IdentityRepository,
  type PermissionKey,
} from "@vayada/backend-auth";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import {
  CHANNEL_MANAGER_VIEW_CONTRACT_VERSION,
  type ChannelManagerView,
} from "@vayada/domain-pms-channex";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { PmsChannexManagementReadRepository } from "./domains/pmsChannexManagementReadModel.js";

const propertyId = "26060000-0000-4000-8000-000000000001";
const otherPropertyId = "26060000-0000-4000-8000-000000000002";
const alertId = "26060000-0000-4000-8000-000000000003";
const url = `/api/pms/properties/${propertyId}/channel-manager`;
const headers = { authorization: "Bearer valid-token" };
// VAY-2498: the account admin's grants hold the old broad keys and every staff key (0002, 0109).
const ACCOUNT_ADMIN: PermissionKey[] = [
  "pms.operations.read",
  "pms.operations.manage",
  ...staffAccessPermissionKeys,
];
// The Agency manager preset (0508) reads the Channel manager; front desk doesn't.
const AGENCY_MANAGER: PermissionKey[] = ["pms.channel_manager.read", "pms.reservation.read"];
const FRONT_DESK: PermissionKey[] = ["pms.reservation.read", "pms.reservation.update"];

const view: ChannelManagerView = {
  contractVersion: CHANNEL_MANAGER_VIEW_CONTRACT_VERSION,
  propertyId,
  connection: { status: "connected" },
  channels: { status: "unavailable" },
  rooms: [],
  sync: {
    prices: { status: "ok", lastSuccessAt: "2026-11-26T10:00:00.000Z", retryAt: null },
    bookings: { status: "never", lastCheckedAt: null, latest: null },
  },
  problems: [],
};

type Access = {
  signedIn?: boolean;
  roleKey?: string;
  permissions?: PermissionKey[];
  scope?: { mode: "all" } | { mode: "assigned"; propertyIds: string[] };
};

describe("Channel manager view route (VAY-2606)", () => {
  let app: Awaited<ReturnType<typeof testApp>>["app"] | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("gives an account admin the view, uncached", async () => {
    const harness = await testApp({ roleKey: "hotel_owner", permissions: ACCOUNT_ADMIN });
    app = harness.app;
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual(view);
    expect(harness.getChannelManagerView).toHaveBeenCalledWith(propertyId);
  });

  it("gives staff with the Channel manager permission the view for a hotel they work for", async () => {
    const harness = await testApp({
      roleKey: "hotel_manager",
      permissions: AGENCY_MANAGER,
      scope: { mode: "assigned", propertyIds: [propertyId] },
    });
    app = harness.app;
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
  });

  const refused: Array<[string, Access, number]> = [
    ["signed out", { signedIn: false }, 401],
    ["without the Channel manager permission", { permissions: FRONT_DESK }, 403],
    [
      "assigned to another hotel only",
      { permissions: AGENCY_MANAGER, scope: { mode: "assigned", propertyIds: [otherPropertyId] } },
      403,
    ],
  ];
  it.each(refused)("refuses staff %s", async (_label, access, statusCode) => {
    const harness = await testApp({ roleKey: "hotel_manager", ...access });
    app = harness.app;
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(statusCode);
    expect(harness.getChannelManagerView).not.toHaveBeenCalled();
  });

  it("refuses a malformed property id before reading anything", async () => {
    const harness = await testApp({ permissions: ACCOUNT_ADMIN });
    app = harness.app;
    const response = await app.inject({
      method: "GET",
      url: "/api/pms/properties/not-a-uuid/channel-manager",
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(harness.getChannelManagerView).not.toHaveBeenCalled();
  });

  it("keeps marking a problem as seen and the old Channex routes for account admins", async () => {
    const harness = await testApp({
      roleKey: "hotel_manager",
      permissions: AGENCY_MANAGER,
      scope: { mode: "assigned", propertyIds: [propertyId] },
    });
    app = harness.app;
    for (const [method, path] of [
      ["POST", `channex/alerts/${alertId}/acknowledge`],
      ["GET", "channex"],
      ["GET", "channex/alerts"],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/pms/properties/${propertyId}/${path}`,
        headers,
        ...(method === "POST" ? { payload: { round: 0 } } : {}),
      });
      expect(response.statusCode, path).toBe(403);
    }
    expect(harness.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("answers 503 when the view isn't wired", async () => {
    const harness = await testApp({ permissions: ACCOUNT_ADMIN }, false);
    app = harness.app;
    expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(503);
  });
});

async function testApp(access: Access = {}, wired = true) {
  const roleKey = access.roleKey ?? "hotel_owner";
  const getChannelManagerView = vi.fn().mockResolvedValue(view);
  const acknowledgeAlert = vi.fn().mockResolvedValue(true);
  const repository: PmsChannexManagementReadRepository = {
    getSnapshot: vi.fn(),
    getOperation: vi.fn().mockResolvedValue(null),
    getAlerts: vi.fn().mockResolvedValue([]),
    acknowledgeAlert,
    ...(wired ? { getChannelManagerView } : {}),
  };
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId() {
      return {
        userId: "26060000-0000-4000-8000-0000000000a1",
        email: "a@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "26060000-0000-4000-8000-0000000000a2",
        workosOrgId: "workos-org-1",
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "26060000-0000-4000-8000-0000000000a3",
        status: "active",
        roleKey,
        workosMembershipId: "workos-membership-1",
        workosRoleSlugs: [roleKey],
      };
    },
    async findLinkedResources() {
      return [propertyId, otherPropertyId].flatMap((resourceId) => [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId,
          relationship: "operator" as const,
          status: "active",
        },
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId,
          relationship: "operator" as const,
          status: "active",
        },
      ]);
    },
  };
  const scope = access.scope ?? { mode: "all" };
  const propertyAccessRepository: PropertyAccessRepository = {
    async findMembershipPropertyScope(context) {
      return {
        mode: scope.mode,
        roleKey: context.membership.roleKey,
        accessOrigin: "agency",
        productAccess: { pms: true, booking: true },
        assignedPropertyIds: scope.mode === "assigned" ? scope.propertyIds : [],
      };
    },
  };
  const app = await buildApp({
    logger: false,
    pmsChannexManagement: {
      repository,
      capabilityModes: {
        connection: "observe_only",
        provisioning: "observe_only",
        ariSync: "observe_only",
        bookingSync: "observe_only",
        markups: "observe_only",
        messaging: "observe_only",
        iframe: "observe_only",
      },
    },
    auth: {
      verifier: createFakeVerifier(
        access.signedIn === false
          ? new Map()
          : new Map([
              [
                "valid-token",
                {
                  workosUserId: "workos-user-1",
                  workosOrgId: "workos-org-1",
                  sessionId: "session-1",
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              ],
            ]),
      ),
      repository: identityRepository,
      propertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return access.permissions ?? ACCOUNT_ADMIN;
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [propertyId, otherPropertyId].map((resourceId) => ({
            product: "pms",
            key: "property-management",
            status: "active",
            resource: { product: "pms", resourceType: "pms_property", resourceId },
          }));
        },
      },
    },
  });
  return { app, getChannelManagerView, acknowledgeAlert };
}
