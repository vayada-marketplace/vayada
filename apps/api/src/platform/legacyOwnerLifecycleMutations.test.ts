import type { IdentityLifecycleCommandBusCommand } from "@vayada/backend-auth";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPgIdentityLifecycleCommandBus } from "./identityLifecycle.js";

const userId = "11111111-1111-4111-8111-111111111111";
const base = {
  commandId: "synthetic-command",
  idempotencyKey: "synthetic-command",
  audit: {
    actor: { kind: "system" as const, service: "test" },
    source: "web" as const,
    requestId: "synthetic-request",
    reason: "Synthetic lifecycle hold test",
    requestedAt: "2026-09-14T00:00:00.000Z",
  },
};
const email: IdentityLifecycleCommandBusCommand = {
  ...base,
  commandType: "identity.user.email.update",
  payload: { userId, email: "synthetic@example.test", providerEmailVerified: true },
};
const statuses = ["active", "pending", "suspended", "deleted"] as const;
function status(value: (typeof statuses)[number]): IdentityLifecycleCommandBusCommand {
  return {
    ...base,
    commandType: "identity.user.status.update",
    payload: { userId, status: value },
  };
}
const expanding = [email, status("active"), status("pending")];

afterEach(() => vi.restoreAllMocks());

function fixture(protectedOwner: boolean | Error, exists = true, failCache = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM identity.users"))
      return { rows: exists ? [{ id: userId }] : [] };
    if (sql.includes("legacy_owner_bootstrap_receipts")) {
      if (protectedOwner instanceof Error) throw protectedOwner;
      return { rows: [{ protected: protectedOwner }] };
    }
    if (failCache && sql.includes("UPDATE identity.external_identities"))
      throw new Error("cache failed");
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  vi.spyOn(pg.Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
  vi.spyOn(pg.Pool.prototype, "query").mockImplementation(query as never);
  const bus = createPgIdentityLifecycleCommandBus({ connectionString: "postgresql://unused" });
  return { query, release, bus };
}

describe("prepared-owner lifecycle mutations", () => {
  it.each(expanding)("denies protected mutation $commandType $payload.status", async (command) => {
    const { query, release, bus } = fixture(true);
    await expect(bus.execute(command)).rejects.toThrow(
      "Legacy owner account reconciliation required",
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT id FROM identity.users WHERE id = $1 FOR UPDATE",
      expect.stringContaining("ANY(owner_user_ids)"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledOnce();
    await bus.close();
  });

  it.each(expanding)(
    "denies unavailable evidence for $commandType $payload.status",
    async (command) => {
      const { query, bus } = fixture(new Error("private database detail"));
      await expect(bus.execute(command)).rejects.toThrow(
        /^Legacy owner account reconciliation required$/,
      );
      expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
      expect(query).toHaveBeenLastCalledWith("ROLLBACK");
      await bus.close();
    },
  );

  it.each(expanding)(
    "does not update a user appearing after the lookup for $commandType $payload.status",
    async (command) => {
      const { query, bus } = fixture(true, false);
      await expect(bus.execute(command)).resolves.toMatchObject({ status: "accepted", userId });
      expect(query.mock.calls.map(([sql]) => sql)).toEqual([
        "BEGIN",
        "SELECT id FROM identity.users WHERE id = $1 FOR UPDATE",
        "COMMIT",
      ]);
      await bus.close();
    },
  );

  it.each(expanding)(
    "preserves ordinary mutation $commandType $payload.status",
    async (command) => {
      const { query, bus } = fixture(false);
      await expect(bus.execute(command)).resolves.toMatchObject({ status: "accepted", userId });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity.users"),
        expect.any(Array),
      );
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      if (command.commandType === "identity.user.email.update") {
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining("UPDATE identity.external_identities"),
          [userId, command.payload.email, true],
        );
      }
      await bus.close();
    },
  );

  it("rolls back both email caches when the second update fails", async () => {
    const { query, release, bus } = fixture(false, true, true);
    await expect(bus.execute(email)).rejects.toThrow("cache failed");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE identity.users"),
      expect.any(Array),
    );
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
    await bus.close();
  });

  it.each([status("suspended"), status("deleted")])(
    "preserves restrictive status $payload.status even if receipts are unreadable",
    async (command) => {
      const { query, bus } = fixture(new Error("receipts unavailable"));
      await expect(bus.execute(command)).resolves.toMatchObject({ status: "accepted", userId });
      expect(
        query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts")),
      ).toBe(false);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity.users"),
        expect.any(Array),
      );
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      await bus.close();
    },
  );

  it.each([
    {
      ...base,
      commandType: "identity.user.suspend",
      payload: { userId, reason: "restrict", suspendMemberships: true, suspendResourceLinks: true },
    },
    {
      ...base,
      commandType: "identity.user.delete",
      payload: { userId, mode: "privacy_erasure" },
    },
    {
      ...base,
      commandType: "identity.access.revoke",
      payload: { userId, organizationId: userId, membershipStatus: "suspended" },
    },
  ] satisfies IdentityLifecycleCommandBusCommand[])(
    "preserves $commandType without a receipt read",
    async (command) => {
      const { query, bus } = fixture(new Error("receipts unavailable"));
      await expect(bus.execute(command)).resolves.toMatchObject({ status: "accepted", userId });
      expect(
        query.mock.calls.some(([sql]) => sql.includes("legacy_owner_bootstrap_receipts")),
      ).toBe(false);
      expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE identity."))).toBe(true);
      await bus.close();
    },
  );
});
