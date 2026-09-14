import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgStaffInvitationRepository } from "./staffInvitations.js";

const id = "11111111-1111-4111-8111-111111111111";
const base = {
  commandId: "test",
  idempotencyKey: "test",
  audit: {
    actor: { kind: "user" as const, userId: id, organizationId: id },
    source: "admin" as const,
    requestId: "test",
    reason: "Test lock compatibility",
    requestedAt: "2026-09-14T00:00:00.000Z",
  },
  payload: { organizationId: id, membershipId: id },
};
afterEach(() => vi.restoreAllMocks());

describe("staff user locks", () => {
  it.each(["status", "remove"] as const)(
    "keeps %s identity snapshots stable without exclusive user locks",
    async (operation) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("actor.name"))
          return {
            rows: [
              {
                membership_id: id,
                name: "Test",
                email: "test@example.test",
                permission_overrides: null,
                role_permissions: ["identity.staff.manage"],
              },
            ],
          };
        if (sql.includes("INSERT INTO platform.idempotency_keys")) return { rows: [{ id }] };
        return { rows: [] };
      });
      const release = vi.fn();
      vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
      const repository = createPgStaffInvitationRepository({
        connectionString: "postgresql://unused",
      });
      const result =
        operation === "status"
          ? await repository.updateStatus({
              ...base,
              commandType: "identity.staff.status.update",
              payload: { ...base.payload, membershipStatus: "suspended" },
            })
          : await repository.remove({ ...base, commandType: "identity.staff.remove" });
      expect(result).toEqual({ outcome: "rejected", reason: "target_not_found" });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("FOR UPDATE OF membership, organization FOR SHARE OF actor"),
        [id, id],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(
          operation === "status"
            ? "FOR UPDATE OF membership FOR SHARE OF staff"
            : "FOR UPDATE OF membership, organization FOR SHARE OF staff",
        ),
        expect.any(Array),
      );
      const managerSql = query.mock.calls.find(([sql]) => sql.includes("actor.name"))![0];
      expect(managerSql).toContain("membership.status = 'active'");
      expect(managerSql).toContain("organization.status = 'active' AND actor.status = 'active'");
      const targetSql = query.mock.calls.find(([sql]) => sql.includes("FOR SHARE OF staff"))![0];
      expect(targetSql).toContain("membership.role_key = ANY($3::text[])");
      expect(targetSql).toContain(
        operation === "status"
          ? "staff.status = 'active'"
          : "staff.status IN ('active', 'suspended')",
      );
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(release).toHaveBeenCalledOnce();
      await repository.close();
    },
  );
});
