import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgStaffInvitationRepository } from "./staffInvitations.js";
import { assertSubjectNotBootstrapProtected } from "./legacyOwnerHold.js";

const org = "11111111-1111-4111-8111-111111111111";
const actor = "33333333-3333-4333-8333-333333333333";
const member = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const subject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const property = "66666666-6666-4666-8666-666666666666";
const audit = {
  actor: { kind: "user" as const, userId: actor, organizationId: org },
  source: "admin" as const,
  requestId: "test",
  reason: "Synthetic test",
  requestedAt: "2026-09-14T00:00:00.000Z",
};
const statusCommand = (status: "active" | "suspended") => ({
  commandType: "identity.staff.status.update" as const,
  commandId: "status-test",
  idempotencyKey: "status-test",
  audit,
  payload: { organizationId: org, membershipId: member, membershipStatus: status },
});
const accessCommand = {
  commandType: "identity.staff.access.update" as const,
  commandId: "access-test",
  idempotencyKey: "access-test",
  audit,
  payload: {
    organizationId: org,
    membershipId: member,
    roleKey: "front_desk" as const,
    propertyAccessMode: "assigned" as const,
    propertyIds: [property],
    permissionOverrides: { grant: [], deny: [] },
  },
};
afterEach(() => vi.restoreAllMocks());

function setup(
  protection: unknown = true,
  options: { replay?: boolean; target?: boolean; status?: string } = {},
) {
  let fingerprint = "";
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("AS role_permissions"))
      return {
        rows: [
          {
            name: "Synthetic",
            email: "test@example.invalid",
            permission_overrides: null,
            role_permissions: ["identity.staff.manage"],
          },
        ],
      };
    if (sql.includes("INSERT INTO platform.idempotency_keys")) {
      fingerprint = values?.[2] as string;
      return { rows: options.replay ? [] : [{ id: org }] };
    }
    if (sql.includes("SELECT request_fingerprint_hash"))
      return {
        rows: [
          {
            request_fingerprint_hash: fingerprint,
            status: "completed",
            response_resource_id: member,
          },
        ],
      };
    if (sql.includes("FROM identity.organization_memberships membership"))
      return {
        rows:
          options.target === false
            ? []
            : [
                {
                  user_id: subject,
                  status: options.status ?? "active",
                  role_key: "front_desk",
                  permission_overrides: null,
                  property_access_mode: "assigned",
                  property_ids: [property],
                },
              ],
      };
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protection instanceof Error) throw protection;
      return { rows: [{ protected: protection }] };
    }
    if (sql.includes("SELECT property.id::text")) return { rows: [{ property_id: property }] };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  const repo = createPgStaffInvitationRepository({ connectionString: "postgres://unused" });
  return { repo, query, release };
}

describe("prepared-owner staff editing hold", () => {
  it.each(["active", "suspended"])(
    "denies active status requests for held %s members",
    async (status) => {
      const { repo, query, release } = setup(true, { status });
      await expect(repo.updateStatus(statusCommand("active"))).rejects.toThrow(
        "Legacy owner account reconciliation required",
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [subject]);
      expect(
        query.mock.calls.some(([sql]) => sql.includes("UPDATE identity.organization_memberships")),
      ).toBe(false);
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledOnce();
      await repo.close();
    },
  );
  it.each(["active", "suspended"])(
    "denies mixed access edits for held %s members",
    async (status) => {
      const { repo, query } = setup(true, { status });
      await expect(repo.updateAccess(accessCommand)).rejects.toThrow(
        "Legacy owner account reconciliation required",
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [subject]);
      expect(
        query.mock.calls.some(([sql]) => /(?:UPDATE|DELETE FROM|INSERT INTO) identity\./.test(sql)),
      ).toBe(false);
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      await repo.close();
    },
  );
  it.each([new Error("permission denied secret"), new Error("missing table secret")])(
    "sanitizes read failure and rolls back reservation",
    async (error) => {
      const { repo, query } = setup(error);
      await expect(repo.updateAccess(accessCommand)).rejects.toThrow(
        /^Legacy owner account reconciliation required$/,
      );
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      await repo.close();
    },
  );
  it("preserves suspension without receipt access", async () => {
    const { repo, query } = setup(new Error("unavailable"));
    await expect(repo.updateStatus(statusCommand("suspended"))).resolves.toMatchObject({
      outcome: "updated",
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts"))).toBe(
      false,
    );
    await repo.close();
  });
  it.each(["status", "access"])(
    "preserves exact %s replay without receipt access",
    async (kind) => {
      const { repo, query } = setup(new Error("unavailable"), { replay: true });
      const result =
        kind === "status"
          ? repo.updateStatus(statusCommand("active"))
          : repo.updateAccess(accessCommand);
      await expect(result).resolves.toMatchObject({ outcome: "idempotent_replay" });
      expect(
        query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts")),
      ).toBe(false);
      await repo.close();
    },
  );
  it.each([
    { rows: [] },
    { rows: [{ protected: undefined }] },
    { rows: [{ protected: null }] },
    { rows: [{ protected: "false" }] },
    { rows: [{ protected: false }, { protected: false }] },
  ])("rejects incomplete receipt result %j", async ({ rows }) => {
    const client = { query: vi.fn().mockResolvedValue({ rows }) };
    await expect(assertSubjectNotBootstrapProtected(client as never, subject)).rejects.toThrow(
      "Legacy owner account reconciliation required",
    );
  });
  it("permits only explicit false", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ protected: false }] }) };
    await expect(
      assertSubjectNotBootstrapProtected(client as never, subject),
    ).resolves.toBeUndefined();
  });
});
