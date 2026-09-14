import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkosMembershipPayload } from "../routes/workosWebhooks.js";
import { createPgWorkosWebhookStore } from "./workosWebhooks.js";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const input: WorkosMembershipPayload = {
  workosUserId: "user_test",
  workosOrgId: "org_test",
  workosMembershipId: "om_test",
  status: "active",
  roleKey: "hotel_owner",
  workosRoleSlugs: ["admin"],
};
afterEach(() => vi.restoreAllMocks());

function fixture(protection: boolean | Error, binding = true, failWrite = false, mapping = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protection instanceof Error) throw protection;
      return { rows: [{ protected: protection }] };
    }
    if (sql.includes("SELECT user_id") && sql.includes("identity.external_identities")) {
      return { rows: !mapping && sql.includes("FOR SHARE") ? [] : [{ user_id: userId }] };
    }
    if (sql.includes("SELECT id FROM identity.users")) return { rows: [{ id: userId }] };
    if (sql.includes("SELECT id, kind"))
      return { rows: [{ id: organizationId, kind: "hotel_group" }] };
    if (/^\s*(UPDATE|INSERT)/.test(sql)) {
      if (failWrite) throw new Error("write failed");
      return { rows: [], rowCount: binding ? 1 : 0 };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  const store = createPgWorkosWebhookStore({ connectionString: "postgresql://unused" });
  return { query, release, store };
}

describe("prepared-owner membership reconciliation", () => {
  it.each(["active", "pending"] as const)(
    "denies held %s before role or linkage writes",
    async (status) => {
      const { query, release, store } = fixture(true);
      await expect(store.upsertWorkosMembership({ ...input, status })).rejects.toThrow(
        "Legacy owner account reconciliation required",
      );
      const sql = query.mock.calls.map(([statement]) => statement);
      expect(sql.some((statement) => /^\s*(INSERT|UPDATE)/.test(statement))).toBe(false);
      expect(sql.indexOf("SELECT id FROM identity.users WHERE id = $1 FOR KEY SHARE")).toBeLessThan(
        sql.findIndex((statement) => statement.includes("FOR SHARE")),
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining("ANY(owner_user_ids)"), [userId]);
      expect(query).toHaveBeenCalledWith(
        "SELECT id, kind FROM identity.organizations WHERE workos_org_id = $1",
        [input.workosOrgId],
      );
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledOnce();
      await store.close();
    },
  );

  it("fails closed when receipt storage cannot be read", async () => {
    const { query, store } = fixture(new Error("private database detail"));
    await expect(store.upsertWorkosMembership(input)).rejects.toThrow(
      /^Legacy owner account reconciliation required$/,
    );
    expect(query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE)/.test(sql))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    await store.close();
  });

  it.each(["active", "pending"] as const)(
    "preserves ordinary %s upsert SQL and retry",
    async (status) => {
      const { query, store } = fixture(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(store.upsertWorkosMembership({ ...input, status })).resolves.toEqual({
          userId,
          organizationId,
        });
      }
      const writes = query.mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO identity.organization_memberships"),
      );
      expect(writes).toHaveLength(2);
      expect(writes[0]).toEqual(writes[1]);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT (organization_id, user_id)"),
        [
          organizationId,
          userId,
          status,
          "hotel_owner",
          null,
          "all",
          "om_test",
          ["admin"],
          status,
          false,
          true,
        ],
      );
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      await store.close();
    },
  );

  it.each(["inactive", "suspended"] as const)(
    "applies exact %s without receipt read or metadata changes",
    async (status) => {
      const { query, store } = fixture(new Error("receipt unavailable"));
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(store.upsertWorkosMembership({ ...input, status })).resolves.toEqual({
          userId,
          organizationId,
        });
      }
      const writes = query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE)/.test(sql));
      expect(writes).toHaveLength(2);
      expect(writes[0]).toEqual(writes[1]);
      expect(writes[0]![0]).toContain(
        "WHERE organization_id = $1 AND user_id = $2 AND workos_membership_id = $3",
      );
      expect(writes[0]![0]).not.toMatch(/SET\s+(role_key|workos_membership_id)|workos_role_slugs/);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity.organization_memberships"),
        [organizationId, userId, "om_test", status],
      );
      expect(
        query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts")),
      ).toBe(false);
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      await store.close();
    },
  );

  it("rejects absent or mismatched restrictive bindings without inserting a membership", async () => {
    const { query, store } = fixture(true, false);
    await expect(store.upsertWorkosMembership({ ...input, status: "inactive" })).rejects.toThrow(
      "requires an exact existing binding",
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    await store.close();
  });

  it("rejects provider-user mapping drift before any write", async () => {
    const { query, store } = fixture(false, true, false, false);
    await expect(store.upsertWorkosMembership(input)).rejects.toThrow(
      "unknown user or organization",
    );
    expect(query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE)/.test(sql))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    await store.close();
  });

  it.each(["active", "inactive"] as const)("rolls back %s write failure", async (status) => {
    const { query, release, store } = fixture(false, true, true);
    await expect(store.upsertWorkosMembership({ ...input, status })).rejects.toThrow(
      "write failed",
    );
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    await store.close();
  });
});
