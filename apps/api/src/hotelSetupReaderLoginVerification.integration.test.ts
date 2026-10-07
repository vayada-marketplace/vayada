import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import * as preflight from "./cli/hotelSetupReaderPreflight.js";
import { activateVerifiedHotelSetupReader } from "./hotelSetupReaderLoginVerification.js";
import { stageHotelSetupReaderRole } from "./hotelSetupReaderRoleStaging.js";

const connectionString = process.env.HOTEL_SETUP_READER_LOGIN_TEST_DATABASE_URL;
describe.runIf(connectionString)("first reader login on isolated TLS PostgreSQL", () => {
  it("verifies the native login, compensates failure and preserves changed credentials", async () => {
    const url = new URL(connectionString!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_") ||
      !process.env.NODE_EXTRA_CA_CERTS
    )
      throw new Error("Reader login proof requires an owned local TLS cluster and test CA");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const role = "vayada_next_hotel_setup_reader";
    const databases = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type)
        FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    let created = false;
    let isolated = false;
    const state = async () =>
      (
        await admin.query(`SELECT oid,rolcanlogin,rolpassword,rolinherit
      FROM pg_catalog.pg_authid WHERE rolname='${role}'`)
      ).rows[0]!;
    const counts = async () =>
      (
        await admin.query(`SELECT
      (SELECT count(*) FROM platform.product_audit_events)::text AS audits,
      (SELECT count(*) FROM finance.expense_categories)::text AS categories,
      (SELECT count(*) FROM pms.property_pricing_settings)::text AS pricing`)
      ).rows;
    try {
      const staged = await stageHotelSetupReaderRole({ connectionString });
      created = true;
      const oid = staged.roleOid;
      expect(oid).toBe(Number((await state()).oid));
      const reader = new URL(url);
      reader.username = role;
      reader.password = randomBytes(36).toString("base64url");
      reader.search = "?sslmode=verify-full";
      const endpoint = new URL(reader);
      endpoint.username = endpoint.password = endpoint.search = "";
      const input = {
        adminDatabaseUrl: url.toString(),
        readerDatabaseUrl: reader.toString(),
        databaseEndpoint: endpoint.toString(),
        expectedRoleOid: oid,
      };
      const before = await counts();
      const reject = async (value = input) =>
        expect(activateVerifiedHotelSetupReader(value)).rejects.toThrow(
          /^Hotel setup reader login verification failed$/,
        );
      await reject({ ...input, expectedRoleOid: oid + 1 });
      await reject({
        ...input,
        readerDatabaseUrl: reader.toString().replace("verify-full", "require"),
      });
      await admin.query(`ALTER ROLE ${role} INHERIT`);
      await reject();
      expect((await state()).rolinherit).toBe(true); // No repair/adoption.
      await admin.query(`ALTER ROLE ${role} NOINHERIT`);

      // Real native preflight fails on unsafe PUBLIC access; compensate the first activation.
      await reject();
      expect((await state()).rolcanlogin).toBe(false);
      expect((await state()).rolpassword === null).toBe(true);
      isolated = true;
      for (const database of databases)
        await admin.query(
          `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
        );
      const attempts = await Promise.allSettled([
        activateVerifiedHotelSetupReader(input),
        activateVerifiedHotelSetupReader(input),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
      const active = await state();
      expect(active.rolcanlogin).toBe(true);
      await reject(); // An already activated credential must not be overwritten.
      expect((await state()).rolpassword === active.rolpassword).toBe(true);
      await admin.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);

      // A trusted concurrent admin changed the verifier: preserve it and require recovery.
      const check = vi
        .spyOn(preflight, "runHotelSetupReaderPreflight")
        .mockImplementationOnce(async () => {
          await admin.query("BEGIN");
          await admin.query("SELECT pg_catalog.set_config('vay1092.test_password',$1,true)", [
            randomBytes(36).toString("base64url"),
          ]);
          await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE ${role} PASSWORD %L',
          pg_catalog.current_setting('vay1092.test_password')); END $$`);
          await admin.query("COMMIT");
          return 1;
        });
      await expect(activateVerifiedHotelSetupReader(input)).rejects.toThrow(
        /^Hotel setup reader login requires recovery inspection$/,
      );
      expect((await state()).rolcanlogin).toBe(true);
      check.mockRestore();
      await admin.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);

      // A replaced role with the same name cannot use the retained original OID.
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      created = false;
      await stageHotelSetupReaderRole({ connectionString });
      created = true;
      await reject();
      expect((await state()).rolcanlogin).toBe(false);
      expect((await state()).rolpassword === null).toBe(true);
      expect(await counts()).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await admin.query("ROLLBACK");
      if (created) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      if (isolated)
        for (const database of databases) {
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
          );
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
            );
        }
      await admin.end();
    }
  }, 60_000);
});
