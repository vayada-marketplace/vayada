// VAY-2574: routes that only checked that a property belongs to the hotel group now also check the
// member's assigned properties. The real buildApp(), route modules, policies and authorization
// resolver run; only storage is faked. A hotel manager is assigned to P1 of an account with P1 and P2;
// the account's owner has every property.
import {
  createFakeVerifier,
  type IdentityRepository,
  type IdentityResourceLink,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import type {
  EntitlementRepository,
  MembershipPropertyScope,
  PropertyAccessRepository,
  RolePermissionRepository,
} from "@vayada/backend-authorization";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const MANAGER = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000002";
const ORG = "bbbbbbbb-0000-4000-8000-00000000000a";
const P1 = "cccccccc-0000-4000-8000-000000000001";
const P2 = "cccccccc-0000-4000-8000-000000000002";

const propertyLinks = (id: string): IdentityResourceLink[] =>
  (
    [
      ["hotel_catalog", "property"],
      ["booking", "booking_hotel"],
      ["pms", "pms_property"],
    ] as const
  ).map(([product, resourceType]) => ({
    product,
    resourceType,
    resourceId: id,
    relationship: "owner",
    status: "active",
  }));

const members = {
  [MANAGER]: { id: "m_manager", roleKey: "hotel_manager", mode: "assigned", assigned: [P1] },
  [OWNER]: { id: "m_owner", roleKey: "hotel_owner", mode: "all", assigned: [] },
} as const;

const identity: IdentityRepository = {
  async findUserByProviderUserId(_provider, providerUserId) {
    const userId = providerUserId === "wos_manager" ? MANAGER : OWNER;
    return {
      userId,
      email: `${userId}@example.test`,
      status: "active",
      workosUserId: providerUserId,
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: ORG,
      workosOrgId: "org_wos",
      name: "Account",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership(userId) {
    const member = members[userId as keyof typeof members];
    return member
      ? {
          membershipId: member.id,
          status: "active",
          roleKey: member.roleKey,
          workosMembershipId: null,
          workosRoleSlugs: [],
        }
      : null;
  },
  async findLinkedResources() {
    return [...propertyLinks(P1), ...propertyLinks(P2)];
  },
} as IdentityRepository;

// Both roles get the same keys, so only the property scope differs. Reviews read on the inbox key
// (VAY-2575); hotel managers and owners hold it.
const keys: PermissionKey[] = [
  "booking.settings.manage",
  "booking.promos.read",
  "booking.promos.manage",
  "booking.addons.read",
  "pms.operations.read",
  "pms.inbox.read",
];
let roleKeys: readonly PermissionKey[] = keys;
const rolePermissions: RolePermissionRepository = {
  async findPermissionsForRole() {
    return [...roleKeys];
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
    const member = Object.values(members).find(
      (candidate) => candidate.id === context.membership.membershipId,
    );
    return member
      ? {
          mode: member.mode,
          roleKey: member.roleKey,
          accessOrigin: "agency",
          assignedPropertyIds: [...member.assigned],
          productAccess: { pms: true, booking: true },
        }
      : null;
  },
};

const sessions = new Map<string, VerifiedSession>(
  (["manager", "owner"] as const).map((who) => [
    who,
    {
      workosUserId: `wos_${who}`,
      workosOrgId: "org_wos",
      sessionId: `sess_${who}`,
      expiresAt: 4102444800,
    },
  ]),
);

// Every storage read records the property it was asked for.
const reads: string[] = [];
const record = <T>(id: string, result: T) => {
  reads.push(id);
  return result;
};
const storage = {
  bookingSettingsRepository: {
    async findPropertySettingsByHotelId(hotelId: string) {
      return record(hotelId, null);
    },
  },
  bookingPromoCodesRepository: {
    async listPromoCodesByHotelId(hotelId: string) {
      return record(hotelId, []);
    },
    async createPromoCodeByHotelId(hotelId: string) {
      return record(hotelId, null);
    },
  },
  bookingAddonItemsRepository: {
    async listAddonItemsByHotelId(hotelId: string) {
      return record(hotelId, null);
    },
  },
  pmsReviewRepository: {
    async list(_context: unknown, propertyId: string) {
      return record(propertyId, { items: [], total: 0 });
    },
  },
  pmsChannexManagement: {
    repository: {
      async getAlerts(propertyId: string) {
        return record(propertyId, []);
      },
    },
    capabilityModes: {},
  },
  pmsOperatingCalendar: {
    readPort: {
      async getCurrentOperatingCalendarConfiguration(propertyId: string) {
        return record(propertyId, null);
      },
    },
    commandPort: {},
    impactPreviewPort: {},
    timeZoneRegistry: {},
  },
  pmsRoomSetup: {
    facts: {
      factsReadPort: {
        async listRoomTypeFacts(propertyId: string) {
          return record(propertyId, []);
        },
      },
      commandPort: {},
      bindingReadPort: {},
      unitReadPort: {},
      capacityReadPort: {},
    },
    physicalUnits: {},
  },
} as unknown as Partial<NonNullable<Parameters<typeof buildApp>[0]>>;

const areas = [
  ["booking settings", (id: string) => `/api/booking/hotels/${id}/settings/property`],
  ["booking policy check", (id: string) => `/api/booking/hotels/${id}/policy-check`],
  ["promo codes", (id: string) => `/api/booking/hotels/${id}/promo-codes`],
  ["add-ons", (id: string) => `/api/booking/hotels/${id}/addon-items`],
  ["reviews", (id: string) => `/api/pms/properties/${id}/reviews`],
  ["Channex alerts", (id: string) => `/api/pms/properties/${id}/channex/alerts`],
  ["operating calendar", (id: string) => `/api/pms/properties/${id}/operating-calendar`],
  ["room setup", (id: string) => `/api/pms/setup/properties/${id}/room-types`],
] as const;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp({
    logger: false,
    ...storage,
    auth: {
      verifier: createFakeVerifier(sessions),
      repository: identity,
      rolePermissionRepository: rolePermissions,
      entitlementRepository: entitlements,
      propertyAccessRepository: propertyAccess,
    },
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  reads.length = 0;
  roleKeys = keys;
});

const get = (token: string, url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("member property scope on group-checked routes (VAY-2574)", () => {
  it.each(areas)(
    "%s: a manager assigned to P1 is refused P2 before any read, and keeps P1",
    async (_area, url) => {
      const other = await get("manager", url(P2));
      expect(other.statusCode).toBe(403);
      expect(reads).not.toContain(P2);

      const own = await get("manager", url(P1));
      expect(own.statusCode).not.toBe(403);
      expect(own.statusCode).toBeLessThan(500);
    },
  );

  it("refuses a write for P2 before it reaches storage (promo code create)", async () => {
    const create = (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/booking/hotels/${id}/promo-codes`,
        headers: { authorization: "Bearer manager" },
        payload: {},
      });

    expect((await create(P2)).statusCode).toBe(403);
    expect(reads).toEqual([]);
    // P1 passes the access check and stops at body validation.
    expect((await create(P1)).statusCode).toBe(422);
  });

  it("needs the inbox key for reviews as well as the property (VAY-2575)", async () => {
    roleKeys = keys.filter((key) => key !== "pms.inbox.read");
    const reviews = (id: string) => `/api/pms/properties/${id}/reviews`;

    expect((await get("manager", reviews(P1))).statusCode).toBe(403);
    expect((await get("owner", reviews(P1))).statusCode).toBe(403);
    expect(reads).toEqual([]);
  });

  it.each(areas)("%s: the owner with every property keeps both", async (_area, url) => {
    for (const id of [P1, P2]) {
      const response = await get("owner", url(id));
      expect(response.statusCode).not.toBe(403);
      expect(response.statusCode).toBeLessThan(500);
    }
  });
});
