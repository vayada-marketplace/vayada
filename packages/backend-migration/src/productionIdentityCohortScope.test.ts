import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  buildProductionIdentityPlan,
  emptyProductionIdentityState,
  type ProductionIdentityPlan,
} from "./productionIdentityPlan.js";
import {
  stableOrganizationId,
  stableQuarantineOrganizationId,
} from "./productionIdentityOwnershipSource.js";

const MIXED = "11111111-1111-4111-8111-111111111111";
const OUTSIDE = "22222222-2222-4222-8222-222222222222";
const CREATOR = "33333333-3333-4333-8333-333333333333";
const COHORT_BOOKING = "aaaaaaaa-0000-4000-8000-000000000001";
const COHORT_PMS = "aaaaaaaa-0000-4000-8000-000000000002";
const MIXED_OUT_BOOKING = "bbbbbbbb-0000-4000-8000-000000000001";
const MIXED_OUT_PROFILE = "bbbbbbbb-0000-4000-8000-000000000002";
const OUT_BOOKING = "cccccccc-0000-4000-8000-000000000001";
const OUT_PMS = "cccccccc-0000-4000-8000-000000000002";
const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const COHORT = {
  bookingHotelIds: [COHORT_BOOKING],
  pmsHotelIds: [COHORT_PMS],
  marketplaceHotelIds: [],
};

describe("production identity cohort scope (VAY-1362)", () => {
  it("leaves a run without a cohort exactly as before", () => {
    const plan = buildProductionIdentityPlan(rows());
    expect(buildProductionIdentityPlan(rows(), undefined, undefined, null)).toEqual(plan);
    expect(plan.blockers).toEqual([]);
    expect(Object.keys(plan.counts).filter((key) => key.startsWith("cohort"))).toEqual([]);
    expect(plan.users.find((user) => user.id === OUTSIDE)).toMatchObject({ status: "active" });
    expect(plan.resourceLinks.every((link) => link.status === "active")).toBe(true);
  });

  it("quarantines non-cohort hotels and keeps a mixed owner on cohort hotels only", () => {
    const plan = buildProductionIdentityPlan(rows(), undefined, undefined, COHORT);
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({
      cohortSuspendedUsers: 1,
      cohortQuarantinedOrganizations: 2,
      cohortQuarantinedResourceLinks: 4,
      quarantinedOrganizations: 0,
      quarantinedResourceLinks: 0,
    });

    const mixedOrg = stableOrganizationId(MIXED, "hotel_group");
    expect(links(plan, mixedOrg)).toEqual([
      ["booking", COHORT_BOOKING, "active"],
      ["pms", COHORT_PMS, "active"],
    ]);
    expect(links(plan, stableQuarantineOrganizationId(MIXED, "hotel_group"))).toEqual([
      ["booking", MIXED_OUT_BOOKING, "archived"],
      ["marketplace", MIXED_OUT_PROFILE, "archived"],
    ]);
    expect(links(plan, stableQuarantineOrganizationId(OUTSIDE, "hotel_group"))).toEqual([
      ["booking", OUT_BOOKING, "archived"],
      ["pms", OUT_PMS, "archived"],
    ]);
    expect(plan.memberships.map((row) => [row.userId, row.status, row.propertyAccessMode])).toEqual(
      expect.arrayContaining([
        [MIXED, "active", "all"],
        [CREATOR, "active", "assigned"],
      ]),
    );
    expect(plan.memberships.some((row) => row.userId === OUTSIDE)).toBe(false);
    const organizations = new Map(plan.organizations.map((row) => [row.id, row.status]));
    expect(organizations.get(stableQuarantineOrganizationId(MIXED, "hotel_group"))).toBe(
      "archived",
    );
    expect(organizations.get(stableQuarantineOrganizationId(OUTSIDE, "hotel_group"))).toBe(
      "archived",
    );
    expect(organizations.has(stableOrganizationId(OUTSIDE, "hotel_group"))).toBe(false);

    const users = new Map(plan.users.map((user) => [user.id, user]));
    expect(users.get(OUTSIDE)).toMatchObject({
      status: "suspended",
      disposition: "outside_migration_cohort",
    });
    expect(users.get(MIXED)).toMatchObject({ status: "active", disposition: "migrate" });
    expect(users.get(CREATOR)).toMatchObject({ status: "active", disposition: "migrate" });

    const outside = [MIXED_OUT_BOOKING, MIXED_OUT_PROFILE, OUT_BOOKING, OUT_PMS];
    const ended = plan.entitlements.filter((row) => outside.includes(row.resourceId));
    expect(ended.map((row) => [row.resourceId, row.status]).sort()).toEqual(
      outside.map((id) => [id, "expired"]).sort(),
    );

    expect(
      buildProductionIdentityPlan([...rows()].reverse(), undefined, undefined, COHORT),
    ).toEqual(plan);
    const verified = buildProductionIdentityPlan(rows(), written(plan), undefined, COHORT);
    expect(verified.blockers).toEqual([]);
    expect(verified.counts.pendingTargetWrites).toBe(0);
    expect(verified.checksum).toBe(plan.checksum);
  });

  it("fails closed when the target keeps a non-cohort owner's access", () => {
    const existing = emptyProductionIdentityState();
    const newer = "2026-03-01T00:00:00.000Z";
    existing.users = [
      { id: OUTSIDE, email: "o@x.test", name: null, status: "active", updatedAt: newer },
    ];
    existing.ownership.resourceLinks = [
      {
        organizationId: stableOrganizationId(OUTSIDE, "hotel_group"),
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: OUT_BOOKING,
        relationship: "owner",
        status: "active",
        updatedAt: FEB,
      },
    ];
    const codes = buildProductionIdentityPlan(rows(), existing, undefined, COHORT).blockers.map(
      (row) => `${row.code}:${row.sourceId}`,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        `ACTIVE_USER_WITHOUT_OWNERSHIP:${OUTSIDE}`,
        `QUARANTINE_RESOURCE_CONFLICT:${OUT_BOOKING}`,
      ]),
    );
  });
});

function links(plan: ProductionIdentityPlan, organizationId: string) {
  return plan.resourceLinks
    .filter((row) => row.organizationId === organizationId)
    .map((row) => [row.product, row.resourceId, row.status]);
}

function written(plan: ProductionIdentityPlan) {
  return {
    ...emptyProductionIdentityState(),
    users: plan.users,
    ownership: {
      organizations: plan.organizations,
      memberships: plan.memberships,
      resourceLinks: plan.resourceLinks,
    },
    entitlements: plan.entitlements,
    privacy: {
      userConsents: plan.userConsents,
      cookieConsents: plan.cookieConsents,
      consentHistory: plan.consentHistory,
      gdprRequests: plan.gdprRequests,
    },
  };
}

function rows(): IdentitySourceRow[] {
  const hotel = (id: string, userId: string, extra: Record<string, unknown> = {}) => ({
    id,
    user_id: userId,
    name: `Hotel ${id.slice(0, 4)}`,
    created_at: JAN,
    updated_at: FEB,
    ...extra,
  });
  const live = { platform_status: "live", slug: "unused" };
  return [
    user(MIXED, "hotel"),
    user(OUTSIDE, "hotel"),
    user(CREATOR, "creator"),
    source("booking", "booking_hotels", hotel(COHORT_BOOKING, MIXED, live)),
    source("booking", "booking_hotels", hotel(MIXED_OUT_BOOKING, MIXED, live)),
    source("booking", "booking_hotels", hotel(OUT_BOOKING, OUTSIDE, live)),
    source("pms", "hotels", hotel(COHORT_PMS, MIXED)),
    source("pms", "hotels", hotel(OUT_PMS, OUTSIDE)),
    source(
      "marketplace",
      "hotel_profiles",
      hotel(MIXED_OUT_PROFILE, MIXED, { status: "verified" }),
    ),
    source("marketplace", "creators", { id: CREATOR, user_id: CREATOR, created_at: JAN }),
    source("pms", "property_module_activations", {
      id: "dddddddd-0000-4000-8000-000000000001",
      hotel_id: OUT_PMS,
      module_id: "channel-manager",
      is_active: true,
      activated_at: JAN,
      deactivated_at: null,
      updated_at: FEB,
    }),
  ];
}

function user(id: string, type: string): IdentitySourceRow {
  return source("auth", "users", {
    id,
    email: `${id.slice(0, 8)}@example.com`,
    name: `User ${id.slice(0, 4)}`,
    type,
    status: "verified",
    email_verified: true,
    is_superadmin: false,
    created_at: JAN,
    updated_at: FEB,
  });
}

function source(
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}
