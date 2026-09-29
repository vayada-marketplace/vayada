import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "../testUtils.js";
import {
  cleanupRole,
  PRODUCTION_PREFLIGHT_TABLES,
  roleMarker,
  roleName,
  withReader,
} from "./legacyHistoricalBindingProductionPreflight.js";

const url = process.env["VAY2017_PRODUCTION_PREFLIGHT_TEST_DATABASE_URL"];
if (url) assertSafeTestDatabase(url);

describe.skipIf(!url)("production historical binding temporary reader", () => {
  const owner = new URL(url!);
  const executionId = `${Date.now()}-${process.pid % 1000}`;
  const interruptedId = `${Date.now() + 1}-${process.pid % 1000}`;
  const admin = new pg.Client({ connectionString: owner.toString() });

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    for (const id of [executionId, interruptedId])
      for (const phase of ["prepare", "execute"] as const)
        await cleanupRole(admin, id, phase).catch(() => undefined);
    await admin.end();
  });

  it("grants exactly ten reads, denies writes, and removes the role after success", async () => {
    await withReader(
      admin,
      owner,
      false,
      executionId,
      "prepare",
      async ({ source }) => {
        for (const table of PRODUCTION_PREFLIGHT_TABLES)
          await expect(source.query(`SELECT 1 FROM ${table} LIMIT 0`)).resolves.toBeDefined();
        await expect(
          source.query("SELECT * FROM booking.pricing_runtime_effective_property_scopes"),
        ).resolves.toMatchObject({ rows: [] });
        await expect(
          source.query("SELECT * FROM booking.pricing_runtime_effective_authority_scopes"),
        ).resolves.toMatchObject({ rows: [] });
        return "ok";
      },
      owner.pathname.slice(1),
    );
    expect(
      (
        await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          roleName(executionId, "prepare"),
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("removes the role when the callback fails", async () => {
    await expect(
      withReader(
        admin,
        owner,
        false,
        executionId,
        "execute",
        async () => {
          throw new Error("fixture failure");
        },
        owner.pathname.slice(1),
      ),
    ).rejects.toThrow("fixture failure");
    expect(
      (
        await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          roleName(executionId, "execute"),
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("reconciles an interrupted exact role and refuses a mismatched marker", async () => {
    const exact = roleName(interruptedId, "prepare");
    await admin.query(`CREATE ROLE ${admin.escapeIdentifier(exact)} LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(
      `COMMENT ON ROLE ${admin.escapeIdentifier(exact)} IS ${admin.escapeLiteral(
        roleMarker(interruptedId, "prepare"),
      )}`,
    );
    await cleanupRole(admin, interruptedId, "prepare");
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [exact])).rowCount).toBe(
      0,
    );

    const mismatched = roleName(interruptedId, "execute");
    await admin.query(`CREATE ROLE ${admin.escapeIdentifier(mismatched)} LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`COMMENT ON ROLE ${admin.escapeIdentifier(mismatched)} IS 'not-ours'`);
    await expect(cleanupRole(admin, interruptedId, "execute")).rejects.toThrow(
      "reader_cleanup_unsafe",
    );
    await admin.query(`DROP ROLE ${admin.escapeIdentifier(mismatched)}`);
  });
});
