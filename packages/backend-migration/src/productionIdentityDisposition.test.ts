import { describe, expect, it } from "vitest";

import {
  planIdentityUserDisposition,
  withoutRetiredUserRows,
  type IdentitySourceRow,
} from "./productionIdentityDisposition.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_USER_ID = "33333333-3333-4333-8333-333333333333";
const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-02-01T00:00:00.000Z";

describe("production identity user disposition", () => {
  it("keeps stable IDs, normalizes email, and preserves verified WorkOS IDs", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [],
      [{ userId: USER_ID, providerUserId: "user_workos_verified" }],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({
        id: USER_ID,
        email: "owner@example.com",
        status: "active",
        disposition: "migrate",
      }),
    ]);
    expect(plan.workosIdentities).toEqual([
      { userId: USER_ID, providerUserId: "user_workos_verified" },
    ]);
  });

  it("preserves newer target state instead of replaying stale source state", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [
        {
          id: USER_ID,
          email: "current@example.com",
          name: null,
          status: "suspended",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.users[0]).toMatchObject({
      email: "current@example.com",
      name: null,
      status: "suspended",
      disposition: "preserve_newer_target",
    });
  });

  it("retires a lower-trust duplicate email without changing the canonical identity", () => {
    const pending = userRow({
      id: OTHER_USER_ID,
      status: "pending",
      email_verified: false,
      updated_at: "2026-03-01T00:00:00.000Z",
    });

    const plan = planIdentityUserDisposition([userRow(), pending]);

    expect(plan.blockers).toEqual([]);
    expect(plan.users.find((user) => user.id === USER_ID)).toMatchObject({
      email: "owner@example.com",
      status: "active",
      disposition: "migrate",
    });
    expect(plan.users.find((user) => user.id === OTHER_USER_ID)).toMatchObject({
      email: `retired-${OTHER_USER_ID}@migration.invalid`,
      status: "deleted",
      disposition: "retire_duplicate_email",
    });
  });

  it("blocks differing user state at equal freshness", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [
        {
          id: USER_ID,
          email: "current@example.com",
          name: "Current",
          status: "suspended",
          updatedAt: "2026-02-01T00:00:00+00:00",
        },
      ],
    );

    expect(plan.blockers).toEqual([
      expect.objectContaining({ code: "USER_EQUAL_TIME_CONFLICT", sourceId: USER_ID }),
    ]);
  });

  it("fails closed on unknown states, duplicate emails, and ambiguous provider IDs", () => {
    const duplicate = userRow({ id: OTHER_USER_ID, email: "other@example.com" });
    const unknown = userRow({ id: "33333333-3333-4333-8333-333333333333", status: "mystery" });
    const plan = planIdentityUserDisposition(
      [userRow(), duplicate, unknown],
      [
        {
          id: USER_ID,
          email: "other@example.com",
          name: "Current",
          status: "active",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      [
        { userId: USER_ID, providerUserId: "user_workos_same" },
        { userId: OTHER_USER_ID, providerUserId: "user_workos_same" },
      ],
    );

    expect(plan.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_EMAIL", "INVALID_PROVIDER_LINK", "INVALID_SOURCE_ROW"]),
    );
    expect(JSON.stringify(plan.blockers)).not.toContain("mystery");
  });

  it("does not migrate creators or affiliates (VAY-2272)", () => {
    const creator = userRow({ id: OTHER_USER_ID, type: "creator" });
    const affiliate = userRow({ id: THIRD_USER_ID, type: "affiliate", email: "a@example.com" });
    const plan = planIdentityUserDisposition(
      [userRow(), creator, affiliate],
      [],
      [
        { userId: USER_ID, providerUserId: "user_workos_hotel" },
        { userId: OTHER_USER_ID, providerUserId: "user_workos_creator" },
      ],
    );

    // The creator shares the hotel owner's email, but no longer competes for it.
    expect(plan.blockers).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({ id: USER_ID, type: "hotel", disposition: "migrate" }),
    ]);
    expect(plan.retiredUserIds).toEqual([OTHER_USER_ID, THIRD_USER_ID]);
    expect(plan.workosIdentities).toEqual([
      { userId: USER_ID, providerUserId: "user_workos_hotel" },
    ]);
  });

  it("keeps a superadmin with a retired legacy type as a platform admin", () => {
    const plan = planIdentityUserDisposition([userRow({ type: "creator", is_superadmin: true })]);

    expect(plan.blockers).toEqual([]);
    expect(plan.retiredUserIds).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({ id: USER_ID, type: "admin", isSuperadmin: true }),
    ]);
  });

  it("drops the auth rows of users who are not migrated and blocks their open GDPR requests", () => {
    const auth = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
      sourceDatabase: "auth",
      sourceTable,
      rowOrdinal: 1,
      data,
    });
    const creator = OTHER_USER_ID.toUpperCase();
    const creatorCookie = auth("cookie_consent", { id: "cookie-creator", user_id: creator });
    const kept = [
      auth("cookie_consent", { id: "cookie-anonymous", user_id: null }),
      auth("login_audit_log", { id: "login-hotel", user_id: USER_ID }),
      auth("login_audit_log", { id: "login-unknown", user_id: null, email: "x@example.com" }),
      // The hotel owner shares the address, so this failed login may be theirs.
      auth("login_audit_log", { id: "login-shared", user_id: null, email: "owner@example.com" }),
      {
        sourceDatabase: "booking",
        sourceTable: "booking_hotels",
        rowOrdinal: 1,
        data: { id: "hotel-1", user_id: creator },
      } satisfies IdentitySourceRow,
    ];
    const result = withoutRetiredUserRows(
      [
        userRow(),
        userRow({ id: creator, type: "creator", email: "Creator@Example.com" }),
        userRow({ id: THIRD_USER_ID, type: "affiliate", email: "owner@example.com" }),
        creatorCookie,
        auth("consent_history", { id: "history-creator", user_id: creator }),
        auth("gdpr_requests", { id: "gdpr-done", user_id: creator, status: "completed" }),
        auth("gdpr_requests", { id: "gdpr-open", user_id: creator, status: "pending" }),
        auth("gdpr_requests", { id: "gdpr-odd", user_id: creator, status: "mystery" }),
        auth("login_audit_log", { id: "login-creator", user_id: creator }),
        auth("login_audit_log", {
          id: "login-failed",
          user_id: null,
          email: "creator@example.com",
        }),
        ...kept,
      ],
      [OTHER_USER_ID, THIRD_USER_ID],
    );

    expect(result.rows).toEqual([
      userRow(),
      { ...creatorCookie, data: { ...creatorCookie.data, user_id: null } },
      ...kept,
    ]);
    expect(result.retiredUserRows).toEqual({
      users: 2,
      cookie_consent_unlinked: 1,
      consent_history: 1,
      gdpr_requests: 3,
      login_audit_log: 2,
    });
    expect(result.blockers.map((row) => row.sourceId)).toEqual(["gdpr-open", "gdpr-odd"]);
    expect(new Set(result.blockers.map((row) => row.code))).toEqual(
      new Set(["RETIRED_USER_OPEN_GDPR_REQUEST"]),
    );
  });
});

function userRow(overrides: Record<string, unknown> = {}): IdentitySourceRow {
  return {
    sourceDatabase: "auth",
    sourceTable: "users",
    rowOrdinal: 1,
    data: {
      id: USER_ID,
      email: "Owner@Example.com",
      name: "Owner",
      type: "hotel",
      status: "verified",
      email_verified: true,
      is_superadmin: false,
      terms_accepted_at: CREATED,
      terms_version: "v1",
      privacy_accepted_at: CREATED,
      privacy_version: "v1",
      marketing_consent: false,
      marketing_consent_at: null,
      created_at: CREATED,
      updated_at: UPDATED,
      ...overrides,
    },
  };
}
