import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
vi.mock("./hotelSetupCurrencyMembership.js", () => ({ lockHotelSetupCurrencyMembership: vi.fn() }));

const input = {
  adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/test?sslmode=verify-full`,
  databaseEndpoint: "postgresql://db.internal/test",
  scope: {
    propertyId: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
    operation: "currency_ready" as const,
  },
};
afterEach(() => vi.restoreAllMocks());

it.each(["grantWarning", "transport", "commit"])("fails closed on %s", async (mode) => {
  const sql: string[] = [];
  const end = vi.fn().mockResolvedValue(undefined);
  class Client extends EventEmitter {
    async connect() {}
    escapeIdentifier(name: string) {
      return `"${name}"`;
    }
    end = end;
    async query(text: string) {
      sql.push(text);
      if (text.startsWith("GRANT INSERT") && mode === "grantWarning")
        this.emit("notice", { code: "01007" });
      if (text.startsWith("GRANT INSERT") && mode === "transport")
        this.emit("error", new Error("private-diagnostic"));
      if (text === "COMMIT" && mode === "commit")
        this.emit("error", new Error("private-diagnostic"));
      if (text.includes("left(rolname") || text.includes("SELECT database_login"))
        return { rows: [] };
      return { rows: [{ oid: 42 }] };
    }
  }
  vi.spyOn(pg, "Client").mockImplementation(function () {
    return new Client();
  } as unknown as typeof pg.Client);
  vi.mocked(lockHotelSetupCurrencyMembership).mockResolvedValue(true);
  await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow(
    mode === "commit" ? "staging requires recovery inspection" : "staging failed",
  );
  expect(sql.includes("COMMIT")).toBe(mode === "commit");
  expect(sql.at(-1)).toBe("ROLLBACK");
  expect(end).toHaveBeenCalledOnce();
});

it("rejects invalid purpose, identity and transport before constructing a client", async () => {
  const constructor = vi.spyOn(pg, "Client");
  for (const invalid of [
    { ...input, scope: { ...input.scope, operation: "__proto__" } },
    { ...input, scope: { ...input.scope, propertyId: "not-a-uuid" } },
    {
      ...input,
      adminDatabaseUrl: input.adminDatabaseUrl.replace("sslmode=verify-full", "sslmode=disable"),
    },
    { ...input, adminDatabaseUrl: input.adminDatabaseUrl.replace("admin:", ":") },
  ])
    await expect(stageHotelSetupPropertyRole(invalid as typeof input)).rejects.toThrow(
      "staging failed",
    );
  expect(constructor).not.toHaveBeenCalled();
});
