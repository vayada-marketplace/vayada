import { describe, expect, it } from "vitest";

import {
  cleanupExpiredRoles,
  cleanupRole,
  roleMarker,
  roleName,
} from "./legacyHistoricalBindingProductionPreflight.js";

describe("production historical binding preflight role cleanup", () => {
  it("removes only the exact marker-bound restricted role", async () => {
    const queries: string[] = [];
    const admin = {
      escapeIdentifier: (value: string) => `"${value}"`,
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM pg_roles WHERE rolname"))
          return {
            rowCount: 1,
            rows: [
              {
                oid: 42,
                rolcanlogin: true,
                rolsuper: false,
                rolcreaterole: false,
                rolcreatedb: false,
                rolinherit: false,
                rolbypassrls: false,
                rolreplication: false,
                marker: roleMarker("12345-1", "prepare"),
              },
            ],
          };
        if (sql.includes("FROM pg_shdepend"))
          return { rowCount: 1, rows: [{ membership: false, ownership: false }] };
        return { rowCount: 0, rows: [] };
      },
    };

    await cleanupRole(admin as never, "12345-1", "prepare");

    expect(roleName("12345-1", "prepare")).toBe("vay2017_preflight_prepare_12345_1");
    expect(queries.some((sql) => sql.startsWith("DROP OWNED BY"))).toBe(true);
    expect(queries.some((sql) => sql.startsWith("DROP ROLE"))).toBe(true);
  });

  it("refuses a role with a different marker", async () => {
    const admin = {
      escapeIdentifier: (value: string) => `"${value}"`,
      async query() {
        return {
          rowCount: 1,
          rows: [
            {
              oid: 42,
              rolcanlogin: true,
              rolsuper: false,
              rolcreaterole: false,
              rolcreatedb: false,
              rolinherit: false,
              rolbypassrls: false,
              rolreplication: false,
              marker: "other",
            },
          ],
        };
      },
    };

    await expect(cleanupRole(admin as never, "12345-1", "execute")).rejects.toThrow(
      "reader_cleanup_unsafe",
    );
  });

  it("reconciles an expired marker-bound role after interruption", async () => {
    const queries: string[] = [];
    const admin = {
      escapeIdentifier: (value: string) => `"${value}"`,
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("rolvaliduntil"))
          return {
            rowCount: 1,
            rows: [
              {
                rolname: roleName("67890-2", "execute"),
                marker: roleMarker("67890-2", "execute"),
              },
            ],
          };
        if (sql.includes("FROM pg_roles WHERE rolname"))
          return {
            rowCount: 1,
            rows: [
              {
                oid: 84,
                rolcanlogin: true,
                rolsuper: false,
                rolcreaterole: false,
                rolcreatedb: false,
                rolinherit: false,
                rolbypassrls: false,
                rolreplication: false,
                marker: roleMarker("67890-2", "execute"),
              },
            ],
          };
        if (sql.includes("FROM pg_shdepend"))
          return { rowCount: 1, rows: [{ membership: false, ownership: false }] };
        return { rowCount: 0, rows: [] };
      },
    };

    await cleanupExpiredRoles(admin as never);

    expect(queries.some((sql) => sql.startsWith("DROP ROLE"))).toBe(true);
  });
});
