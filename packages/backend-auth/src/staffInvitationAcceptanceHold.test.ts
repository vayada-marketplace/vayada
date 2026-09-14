import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgStaffInvitationAcceptanceRepository } from "./staffInvitationAcceptance.js";

const userId = "11111111-1111-4111-8111-111111111111";
const event = {
  providerEventId: "evt_test",
  providerInvitationId: "inv_test",
  providerUserId: "user_test",
  providerOrganizationId: "org_test",
  invitationEmail: "staff@example.test",
};
const invitation = {
  id: "invitation-id",
  organization_id: "organization-id",
  email: event.invitationEmail,
  role_key: "front_desk",
  permission_overrides: { grant: [], deny: [] },
  property_access_mode: "assigned",
  status: "pending",
  delivery_state: "delivered",
  is_expired: false,
  accepted_user_id: null,
  accepted_membership_id: null,
  request_id: "request-test",
  organization_kind: "hotel_group",
  organization_status: "active",
  workos_org_id: event.providerOrganizationId,
  property_ids: [userId],
};

function setup(
  options: {
    receipt?: unknown;
    receiptError?: string;
    status?: string;
    missingIdentity?: boolean;
    invitation?: Partial<typeof invitation>;
    failAssignments?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("FROM identity.staff_invitations invitation"))
      return { rows: [{ ...invitation, ...options.invitation }] };
    if (sql.includes("FROM identity.external_identities external"))
      return {
        rows: options.missingIdentity
          ? []
          : [
              {
                user_id: userId,
                status: options.status ?? "active",
                name: "Test",
                provider_email: event.invitationEmail,
                provider_email_verified: true,
              },
            ],
      };
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (options.receiptError) throw new Error(options.receiptError);
      return { rows: [{ protected: options.receipt === undefined ? false : options.receipt }] };
    }
    if (sql.includes("FOR SHARE OF assignment, link")) return { rows: [{ property_id: userId }] };
    if (sql.includes("INSERT INTO identity.organization_memberships"))
      return { rows: [{ id: "membership-id" }] };
    if (
      options.failAssignments &&
      sql.includes("INSERT INTO identity.membership_property_assignments")
    )
      throw new Error("assignment failure");
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
  const repository = createPgStaffInvitationAcceptanceRepository({
    connectionString: "postgresql://unused",
  });
  return { query, release, repository };
}

afterEach(() => vi.restoreAllMocks());

describe("staff acceptance prepared-owner hold", () => {
  it.each(["active", "pending"])(
    "denies a held %s subject before any access or audit writes",
    async (status) => {
      const { repository, query, release } = setup({ status, receipt: true });
      await expect(repository.reconcile(event)).rejects.toThrow(
        "Legacy owner account reconciliation required",
      );
      expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE OF external, users"), [
        event.providerUserId,
      ]);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [userId]);
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { receiptError: "relation does not exist: private schema" },
    { receiptError: "permission denied: private principal" },
    { receipt: null },
    { receipt: "false" },
  ])("fails closed for unavailable or malformed receipt reads: %j", async (options) => {
    const { repository, query } = setup(options);
    await expect(repository.reconcile(event)).rejects.toThrow(
      /^Legacy owner account reconciliation required$/,
    );
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("keeps ordinary acceptance transactional and checks before membership writes", async () => {
    const { repository, query } = setup();
    await expect(repository.reconcile(event)).resolves.toMatchObject({
      outcome: "accepted",
      membershipId: "membership-id",
    });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(
      statements.findIndex((sql) => sql.includes("legacy_owner_bootstrap_receipts")),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes("INSERT INTO identity.organization_memberships")),
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rolls back ordinary acceptance if a later assignment write fails", async () => {
    const { repository, query, release } = setup({ failAssignments: true });
    await expect(repository.reconcile(event)).rejects.toThrow("assignment failure");
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves exact no-write replay without consulting receipt storage", async () => {
    const { repository, query } = setup({
      receiptError: "unavailable",
      invitation: {
        status: "accepted",
        accepted_user_id: userId as never,
        accepted_membership_id: "membership-id" as never,
      },
    });
    await expect(repository.reconcile(event)).resolves.toMatchObject({
      outcome: "idempotent_replay",
    });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          /^(INSERT|UPDATE|DELETE)/.test(sql) || sql.includes("legacy_owner_bootstrap_receipts"),
      ),
    ).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it.each(["expired", "revoked", "missing"])(
    "preserves %s handling without receipt access",
    async (caseName) => {
      const { repository, query } = setup({
        receiptError: "unavailable",
        missingIdentity: caseName === "missing",
        invitation:
          caseName === "expired"
            ? { is_expired: true }
            : caseName === "revoked"
              ? { status: "revoked" }
              : {},
      });
      await expect(repository.reconcile(event)).resolves.toMatchObject({
        outcome: caseName === "missing" ? "deferred" : "rejected",
        reason:
          caseName === "expired"
            ? "invitation_expired"
            : caseName === "revoked"
              ? "invitation_not_current"
              : "identity_not_found",
      });
      expect(
        query.mock.calls.some(
          ([sql]) =>
            sql.includes("legacy_owner_bootstrap_receipts") ||
            sql.includes("INSERT INTO identity.organization_memberships"),
        ),
      ).toBe(false);
    },
  );
});
