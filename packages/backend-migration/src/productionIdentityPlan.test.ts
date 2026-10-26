import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  buildProductionIdentityPlan,
  emptyProductionIdentityState,
} from "./productionIdentityPlan.js";

const USER = "11111111-1111-4111-8111-111111111111";
const HOTEL = "22222222-2222-4222-8222-222222222222";
const AUDIT = "33333333-3333-4333-8333-333333333333";
const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const MAR = "2026-03-01T00:00:00.000Z";

describe("production identity plan", () => {
  it("assembles a deterministic cross-domain plan and checksum", () => {
    const rows = validRows();
    const existing = {
      users: [],
      workosIdentities: [{ userId: USER, providerUserId: "user_workos_verified" }],
      ownership: { organizations: [], memberships: [], resourceLinks: [] },
      entitlements: [],
      privacy: { userConsents: [], cookieConsents: [], consentHistory: [], gdprRequests: [] },
      auditEvents: [],
    };

    const first = buildProductionIdentityPlan(rows, existing);
    const second = buildProductionIdentityPlan([...rows].reverse(), existing);

    expect(first).toEqual(second);
    expect(first.blockers).toEqual([]);
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(first.counts).toMatchObject({
      users: 1,
      pendingTargetWrites: 7,
      organizations: 1,
      memberships: 1,
      resourceLinks: 1,
      entitlements: 1,
      workosIdentities: 1,
      userConsents: 1,
      loginAuditEvents: 1,
      retiredAuthRows: 1,
    });

    const verified = buildProductionIdentityPlan(rows, {
      users: first.users,
      workosIdentities: first.workosIdentities,
      ownership: {
        organizations: first.organizations,
        memberships: first.memberships,
        resourceLinks: first.resourceLinks,
      },
      entitlements: first.entitlements,
      privacy: {
        userConsents: first.userConsents,
        cookieConsents: first.cookieConsents,
        consentHistory: first.consentHistory,
        gdprRequests: first.gdprRequests,
      },
      auditEvents: first.auditEvents,
    });
    expect(verified.counts.pendingTargetWrites).toBe(0);
    expect(verified.checksum).toBe(first.checksum);
  });

  it("leaves creators, affiliates and Marketplace ownership out of the plan (VAY-2272)", () => {
    const creator = "44444444-4444-4444-8444-444444444444";
    const creatorHotel = "88888888-8888-4888-8888-888888888888";
    const cookie = (id: string, userId: string | null, analytics: boolean, updatedAt: string) =>
      source("auth", "cookie_consent", {
        id,
        visitor_id: "visitor-1",
        user_id: userId,
        necessary: true,
        functional: false,
        analytics,
        marketing: false,
        created_at: JAN,
        updated_at: updatedAt,
      });
    const rows = [
      ...validRows(),
      source("auth", "users", {
        ...validRows()[0]!.data,
        id: creator,
        email: "creator@example.com",
        type: "creator",
      }),
      source("auth", "login_audit_log", {
        ...auditData(),
        id: "55555555-5555-4555-8555-555555555555",
        user_id: creator,
      }),
      // A failed login names the creator by email only.
      source("auth", "login_audit_log", {
        ...auditData(),
        id: "56565656-5656-4565-8565-565656565656",
        user_id: null,
        email: "Creator@Example.com",
        success: false,
      }),
      // The creator's newer choice still wins for the visitor, without the user.
      cookie("99999999-9999-4999-8999-999999999991", null, true, JAN),
      cookie("99999999-9999-4999-8999-999999999992", creator, false, FEB),
      source("marketplace", "creators", { id: creator, user_id: creator, created_at: JAN }),
      source("marketplace", "hotel_profiles", {
        id: "66666666-6666-4666-8666-666666666666",
        user_id: USER,
        name: "Hotel One",
        status: "verified",
        created_at: JAN,
      }),
      source("pms", "affiliates", {
        id: "77777777-7777-4777-8777-777777777777",
        user_id: creator,
        full_name: "Affiliate",
        status: "approved",
        created_at: JAN,
      }),
      // A hotel the creator owned is quarantined without a user, as before.
      source("booking", "booking_hotels", {
        id: creatorHotel,
        user_id: creator,
        name: "Creator hotel",
        platform_status: "live",
        created_at: JAN,
        updated_at: FEB,
      }),
    ];
    const existing = emptyProductionIdentityState();
    existing.users.push({
      id: creator,
      email: "creator@example.com",
      name: "Creator",
      status: "active",
      updatedAt: FEB,
    });

    const plan = buildProductionIdentityPlan(rows, existing);

    expect(plan.blockers).toEqual([]);
    expect(plan.users.map((row) => row.id)).toEqual([USER]);
    expect(plan.organizations.map((row) => [row.kind, row.status])).toEqual(
      expect.arrayContaining([
        ["hotel_group", "active"],
        ["hotel_group", "archived"],
      ]),
    );
    expect(plan.organizations).toHaveLength(2);
    expect(plan.memberships.map((row) => row.userId)).toEqual([USER]);
    expect(plan.resourceLinks.map((row) => `${row.product}:${row.resourceType}`)).toEqual([
      "booking:booking_hotel",
      "booking:booking_hotel",
    ]);
    expect(new Set(plan.entitlements.map((row) => row.entitlementKey))).toEqual(
      new Set(["booking-engine"]),
    );
    expect(plan.auditEvents.map((row) => row.actorUserId)).toEqual([USER]);
    expect(plan.cookieConsents).toEqual([
      expect.objectContaining({ visitorId: "visitor-1", userId: null, analytics: false }),
    ]);
    expect(plan.retiredProductUserIds).toEqual([creator]);
    expect(plan.retiredProductUserRows).toEqual({
      users: 1,
      login_audit_log: 2,
      cookie_consent_unlinked: 1,
    });
    expect(plan.counts).toMatchObject({
      users: 1,
      retiredProductUsers: 1,
      retiredProductUsersInTarget: 1,
      retiredProductUserRows: 3,
      quarantinedUsers: 0,
      quarantinedOrganizations: 1,
      loginAuditEvents: 1,
    });
  });

  it("names the hotel users whose only legacy hotel was a Marketplace profile (VAY-2272)", () => {
    const rows = [
      validRows()[0]!,
      source("marketplace", "hotel_profiles", {
        id: "66666666-6666-4666-8666-666666666666",
        user_id: USER,
        name: "Hotel One",
        status: "verified",
        created_at: JAN,
      }),
    ];

    expect(buildProductionIdentityPlan(rows).blockers).toEqual([
      expect.objectContaining({ code: "MARKETPLACE_ONLY_HOTEL_OWNER", sourceId: USER }),
    ]);
    // Without the profile, an active hotel user with no hotel keeps the general blocker.
    expect(buildProductionIdentityPlan([validRows()[0]!]).blockers).toEqual([
      expect.objectContaining({ code: "ACTIVE_USER_WITHOUT_OWNERSHIP", sourceId: USER }),
    ]);
  });

  it("blocks a retired owner's hotel with a future booking as an owner type mismatch", () => {
    const creator = "44444444-4444-4444-8444-444444444444";
    const rows = [
      source("auth", "users", { ...validRows()[0]!.data, id: creator, type: "creator" }),
      source("booking", "booking_hotels", {
        id: HOTEL,
        user_id: creator,
        name: "Creator hotel",
        platform_status: "live",
        created_at: JAN,
        updated_at: FEB,
      }),
      source("pms", "bookings", {
        id: "88888888-8888-4888-8888-888888888888",
        hotel_id: HOTEL,
        status: "confirmed",
        is_test_booking: false,
        check_out: "2099-01-01",
      }),
    ];

    expect(buildProductionIdentityPlan(rows).blockers.map((row) => row.code)).toEqual([
      "OWNER_TYPE_MISMATCH_WITH_FUTURE_BOOKING",
    ]);
  });

  it("combines fail-closed blockers without losing deterministic counts", () => {
    const rows = validRows();
    rows.push({
      ...rows[0]!,
      data: { ...rows[0]!.data, name: "Conflicting duplicate user" },
    });
    rows.push(
      source("booking", "booking_hotels", {
        id: "44444444-4444-4444-8444-444444444444",
        user_id: USER,
        name: "Bad hotel",
        platform_status: "stale_unknown",
        created_at: JAN,
        updated_at: FEB,
      }),
      source("auth", "login_audit_log", {
        ...auditData(),
        id: "55555555-5555-4555-8555-555555555555",
        auth_method: "owner@example.com",
      }),
    );

    const existing = emptyProductionIdentityState();
    existing.workosIdentities = [
      { userId: USER, providerUserId: "user_workos_z" },
      { userId: USER, providerUserId: "user_workos_a" },
    ];
    const plan = buildProductionIdentityPlan(rows, existing);

    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["INVALID_SOURCE_ROW"]),
    );
    expect(
      buildProductionIdentityPlan([...rows].reverse(), {
        ...existing,
        workosIdentities: [...existing.workosIdentities].reverse(),
      }),
    ).toEqual(plan);
  });

  it("keeps equal-time target disagreement out of an applicable plan", () => {
    const existing = emptyProductionIdentityState();
    existing.users = [
      {
        id: USER,
        email: "current@example.com",
        name: "Current",
        status: "suspended",
        updatedAt: "2026-02-01T00:00:00+00:00",
      },
    ];

    expect(buildProductionIdentityPlan(validRows(), existing).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "USER_EQUAL_TIME_CONFLICT" })]),
    );
  });

  it("lets newer user retirement close stale target access and entitlements", () => {
    const rows = validRows();
    rows[0] = {
      ...rows[0]!,
      data: { ...rows[0]!.data, status: "rejected", updated_at: MAR },
    };
    rows[1] = {
      ...rows[1]!,
      data: { ...rows[1]!.data, updated_at: JAN },
    };
    const generated = buildProductionIdentityPlan(rows);
    const sourceEntitlement = generated.entitlements[0]!;
    const existing = emptyProductionIdentityState();
    existing.ownership.resourceLinks = [
      {
        ...generated.resourceLinks[0]!,
        status: "active",
        updatedAt: FEB,
      },
    ];
    existing.entitlements = [
      {
        ...sourceEntitlement,
        status: "active",
        expiresAt: null,
        updatedAt: FEB,
      },
    ];

    const plan = buildProductionIdentityPlan(rows, existing);

    expect(plan.blockers).toEqual([]);
    expect(plan.memberships[0]).toMatchObject({ status: "inactive", updatedAt: MAR });
    expect(plan.resourceLinks[0]).toMatchObject({ status: "archived", updatedAt: MAR });
    expect(plan.entitlements[0]).toMatchObject({ status: "expired", updatedAt: MAR });
  });

  it("counts an access-ending entitlement write even when the active target is newer", () => {
    const rows = validRows();
    rows[0] = {
      ...rows[0]!,
      data: { ...rows[0]!.data, status: "rejected" },
    };
    const generated = buildProductionIdentityPlan(rows);
    const existing = {
      users: generated.users,
      workosIdentities: generated.workosIdentities,
      ownership: {
        organizations: generated.organizations,
        memberships: generated.memberships,
        resourceLinks: generated.resourceLinks,
      },
      entitlements: [
        {
          ...generated.entitlements[0]!,
          status: "active" as const,
          updatedAt: MAR,
        },
      ],
      privacy: {
        userConsents: generated.userConsents,
        cookieConsents: generated.cookieConsents,
        consentHistory: generated.consentHistory,
        gdprRequests: generated.gdprRequests,
      },
      auditEvents: generated.auditEvents,
    };

    const plan = buildProductionIdentityPlan(rows, existing);

    expect(plan.blockers).toEqual([]);
    expect(plan.entitlements[0]).toMatchObject({ status: "expired", updatedAt: MAR });
    expect(plan.counts.pendingTargetWrites).toBe(1);
  });

  it("quarantines a missing owner while preserving historical booking input", () => {
    const rows = [validRows()[1]!];
    rows.push(
      source("pms", "bookings", {
        id: "55555555-5555-4555-8555-555555555555",
        hotel_id: HOTEL,
        status: "confirmed",
        is_test_booking: false,
        check_out: JAN,
        created_at: JAN,
      }),
    );

    const plan = buildProductionIdentityPlan(rows, undefined, FEB);

    expect(plan.blockers).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({
        id: USER,
        status: "deleted",
        disposition: "quarantine_missing_owner",
      }),
    ]);
    expect(plan.memberships).toEqual([expect.objectContaining({ status: "inactive" })]);
    expect(plan.resourceLinks).toEqual([expect.objectContaining({ status: "archived" })]);
    expect(plan.entitlements).toEqual([expect.objectContaining({ status: "expired" })]);
    expect(plan.counts).toMatchObject({
      quarantinedUsers: 1,
      quarantinedOrganizations: 1,
      quarantinedResourceLinks: 1,
    });
  });

  it("does not quarantine an orphan with a future operational booking", () => {
    const rows = [validRows()[1]!];
    rows.push(
      source("pms", "bookings", {
        id: "55555555-5555-4555-8555-555555555555",
        hotel_id: HOTEL,
        status: "confirmed",
        is_test_booking: false,
        check_out: MAR,
        created_at: JAN,
      }),
    );

    const plan = buildProductionIdentityPlan(rows, undefined, FEB);

    expect(plan.users).toEqual([]);
    expect(plan.blockers).toEqual([
      expect.objectContaining({ code: "ORPHAN_PRODUCT_USER_WITH_FUTURE_BOOKING" }),
    ]);
  });

  it("treats a nonterminal checkout on the snapshot calendar day as operational", () => {
    const rows = [validRows()[1]!];
    rows.push(
      source("pms", "bookings", {
        id: "55555555-5555-4555-8555-555555555555",
        hotel_id: HOTEL,
        status: "confirmed",
        is_test_booking: false,
        check_out: "2026-02-01",
        created_at: JAN,
      }),
    );

    const plan = buildProductionIdentityPlan(rows, undefined, "2026-02-01T05:00:00.000Z");

    expect(plan.users).toEqual([]);
    expect(plan.blockers).toEqual([
      expect.objectContaining({ code: "ORPHAN_PRODUCT_USER_WITH_FUTURE_BOOKING" }),
    ]);
  });

  it("blocks when a synthetic quarantine address is already owned by another identity", () => {
    const existing = emptyProductionIdentityState();
    existing.users = [
      {
        id: AUDIT,
        email: `retired-owner-${USER}@migration.invalid`,
        name: "Existing",
        status: "deleted",
        updatedAt: FEB,
      },
    ];

    expect(buildProductionIdentityPlan([validRows()[1]!], existing).blockers).toEqual([
      expect.objectContaining({ code: "QUARANTINE_USER_EMAIL_CONFLICT" }),
    ]);
  });
});

function validRows(): IdentitySourceRow[] {
  return [
    source("auth", "users", {
      id: USER,
      email: "Owner@Example.com",
      name: "Owner",
      type: "hotel",
      status: "verified",
      email_verified: true,
      is_superadmin: false,
      terms_accepted_at: JAN,
      terms_version: "v1",
      privacy_accepted_at: JAN,
      privacy_version: "v1",
      marketing_consent: false,
      marketing_consent_at: null,
      created_at: JAN,
      updated_at: FEB,
    }),
    source("booking", "booking_hotels", {
      id: HOTEL,
      user_id: USER,
      name: "Hotel One",
      platform_status: "live",
      created_at: JAN,
      updated_at: FEB,
    }),
    source("auth", "login_audit_log", auditData()),
    source("auth", "password_reset_tokens", { id: AUDIT }),
  ];
}
function auditData() {
  return {
    id: AUDIT,
    user_id: USER,
    email: "owner@example.com",
    success: true,
    auth_method: "password",
    failure_reason: null,
    ip_address: "192.0.2.1",
    user_agent: "test",
    created_at: FEB,
  };
}
function source(
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}
