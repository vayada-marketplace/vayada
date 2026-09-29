import { describe, expect, it } from "vitest";
import pg from "pg";

import { ChannexAdoptionConsumptionError } from "../channexAdoptionConsumptionError.js";
import {
  cleanupExpiredRoles,
  cleanupRole,
  roleMarker,
  roleName,
  safeErrorCode,
} from "./legacyHistoricalBindingProductionPreflight.js";

describe("production historical binding preflight role cleanup", () => {
  it("reports only safe stage or PostgreSQL error codes", () => {
    expect(safeErrorCode(new Error("image_source_mismatch"))).toBe("image_source_mismatch");
    const postgresError = new pg.DatabaseError("contains production detail", 0, "error");
    postgresError.code = "55P03";
    expect(safeErrorCode(postgresError)).toBe("postgres_55p03");
    expect(
      safeErrorCode(new ChannexAdoptionConsumptionError("SOURCE_RUN_MISMATCH", "detail")),
    ).toBe("source_run_mismatch");
    expect(safeErrorCode(new Error("Historical connection preparation target pair mismatch"))).toBe(
      "historical_connection_preparation_target_pair_mismatch",
    );
    expect(
      safeErrorCode(new Error("Historical connection preparation source is not preprod")),
    ).toBe("historical_connection_preparation_source_is_not_preprod");
    expect(safeErrorCode(new Error("contains production detail"))).toBe(
      "historical_binding_preflight_failed",
    );
    expect(safeErrorCode(new Error("vayada_target_prod"))).toBe(
      "historical_binding_preflight_failed",
    );
    expect(safeErrorCode(Object.assign(new Error("detail"), { code: "CUSTOMER_ACME" }))).toBe(
      "historical_binding_preflight_failed",
    );
    expect(safeErrorCode(Object.assign(new Error("detail"), { code: "EPIPE" }))).toBe(
      "historical_binding_preflight_failed",
    );
  });

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
        if (sql.includes("current_database()"))
          return { rowCount: 1, rows: [{ database: "vay2017_production_preflight_test" }] };
        return { rowCount: 0, rows: [] };
      },
    };

    await cleanupRole(admin as never, "12345-1", "prepare");

    expect(roleName("12345-1", "prepare")).toBe("vay2017_preflight_prepare_12345_1");
    expect(queries.filter((sql) => sql.startsWith("REVOKE SELECT ON"))).toHaveLength(10);
    expect(queries.filter((sql) => sql.startsWith("REVOKE USAGE ON SCHEMA"))).toHaveLength(7);
    expect(
      queries.some((sql) =>
        sql.startsWith('REVOKE CONNECT ON DATABASE "vay2017_production_preflight_test"'),
      ),
    ).toBe(true);
    expect(queries.some((sql) => sql.startsWith("DROP OWNED BY"))).toBe(false);
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
        if (sql.includes("current_database()"))
          return { rowCount: 1, rows: [{ database: "vay2017_production_preflight_test" }] };
        return { rowCount: 0, rows: [] };
      },
    };

    await cleanupExpiredRoles(admin as never);

    expect(queries.some((sql) => sql.startsWith("DROP ROLE"))).toBe(true);
  });
});
