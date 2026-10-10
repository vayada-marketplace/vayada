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
const policyHelper = "platform.channex_management_worker_scope(text,text,uuid)";

describe.skipIf(!url)("production historical binding temporary reader", () => {
  const owner = new URL(url!);
  const executionId = `${Date.now()}-${process.pid % 1000}`;
  const interruptedId = `${Date.now() + 1}-${process.pid % 1000}`;
  const limitedExecutionId = `${Date.now() + 2}-${process.pid % 1000}`;
  const limitedAdminRole = `vay2017_cleanup_admin_${process.pid}`;
  const admin = new pg.Client({ connectionString: owner.toString() });
  let fixturePropertyId: string;
  const limitedOwner = new URL(owner);
  limitedOwner.username = limitedAdminRole;
  limitedOwner.password = "cleanup_admin_test_only";
  const limitedAdmin = new pg.Client({ connectionString: limitedOwner.toString() });

  beforeAll(async () => {
    await admin.connect();
    fixturePropertyId = (
      await admin.query<{ id: string }>(
        "INSERT INTO hotel_catalog.properties(public_id,display_name) VALUES($1,'VAY2017 test') RETURNING id::text",
        [`vay2017-policy-helper-${executionId}`],
      )
    ).rows[0]!.id;
    await admin.query(
      `CREATE ROLE ${admin.escapeIdentifier(limitedAdminRole)} LOGIN CREATEROLE PASSWORD 'cleanup_admin_test_only'`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(owner.pathname.slice(1))} TO ${admin.escapeIdentifier(limitedAdminRole)} WITH GRANT OPTION`,
    );
    for (const schema of new Set(PRODUCTION_PREFLIGHT_TABLES.map((table) => table.split(".")[0])))
      await admin.query(
        `GRANT USAGE ON SCHEMA ${schema} TO ${admin.escapeIdentifier(limitedAdminRole)} WITH GRANT OPTION`,
      );
    for (const table of PRODUCTION_PREFLIGHT_TABLES)
      await admin.query(
        `GRANT SELECT ON ${table} TO ${admin.escapeIdentifier(limitedAdminRole)} WITH GRANT OPTION`,
      );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION ${policyHelper} TO ${admin.escapeIdentifier(limitedAdminRole)} WITH GRANT OPTION`,
    );
    await limitedAdmin.connect();
  });

  afterAll(async () => {
    for (const id of [executionId, interruptedId])
      for (const phase of ["prepare", "execute"] as const)
        await cleanupRole(admin, id, phase).catch(() => undefined);
    for (const phase of ["prepare", "execute"] as const)
      await cleanupRole(limitedAdmin, limitedExecutionId, phase).catch(() => undefined);
    await limitedAdmin.end();
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1::uuid", [
      fixturePropertyId,
    ]);
    await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(limitedAdminRole)}`);
    await admin.query(`DROP ROLE ${admin.escapeIdentifier(limitedAdminRole)}`);
    await admin.end();
  });

  it("cleans a reader created by a non-superuser CREATEROLE admin", async () => {
    await withReader(
      limitedAdmin,
      limitedOwner,
      false,
      limitedExecutionId,
      "prepare",
      async () => "ok",
      owner.pathname.slice(1),
    );
    expect(
      (
        await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          roleName(limitedExecutionId, "prepare"),
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("grants exactly ten reads and the shared policy helper, denies writes, and removes the role", async () => {
    await withReader(
      admin,
      owner,
      false,
      executionId,
      "prepare",
      async ({ source }) => {
        for (const table of PRODUCTION_PREFLIGHT_TABLES)
          await expect(source.query(`SELECT 1 FROM ${table} LIMIT 0`)).resolves.toBeDefined();
        const property = await source.query<{ id: string }>(
          "SELECT id::text FROM hotel_catalog.properties WHERE id=$1::uuid",
          [fixturePropertyId],
        );
        expect(property.rows[0]?.id).toBe(fixturePropertyId);
        const helperGrant = await source.query<{ granted: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_proc p
            CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
            WHERE p.oid=$1::regprocedure AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
              AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable) AS granted`,
          [policyHelper],
        );
        expect(helperGrant.rows[0]?.granted).toBe(true);
        await expect(
          source.query("SELECT * FROM booking.pricing_runtime_effective_property_scopes"),
        ).rejects.toMatchObject({ code: "42501" });
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
