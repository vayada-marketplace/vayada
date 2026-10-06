import pg from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertHotelSetupReaderRlsHelpers,
  HOTEL_SETUP_READER_RLS_HELPERS,
} from "./hotelSetupReaderPrivileges.js";

const connectionString = process.env.HOTEL_SETUP_READER_RLS_TEST_DATABASE_URL;

describe.runIf(connectionString)("setup reader RLS helper permissions", () => {
  it("reproduces the denied read, fixes it with EXECUTE only, and keeps row and write restrictions", async () => {
    const url = new URL(connectionString!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/side_rls_proof")
      throw new Error("RLS proof requires an owned disposable local database");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(`CREATE SCHEMA identity; CREATE SCHEMA platform;
        CREATE ROLE vayada_next_hotel_setup_creation_reader NOLOGIN NOINHERIT;
        CREATE TABLE identity.organizations(id integer PRIMARY KEY);
        INSERT INTO identity.organizations VALUES(1),(2);
        ALTER TABLE identity.organizations ENABLE ROW LEVEL SECURITY;
        CREATE POLICY owner_scope ON identity.organizations USING(id=1);
        GRANT USAGE ON SCHEMA identity,platform TO vayada_next_hotel_setup_creation_reader;
        GRANT SELECT(id) ON identity.organizations TO vayada_next_hotel_setup_creation_reader;`);
      for (const file of [
        "0407_channex_management_worker_queue_scope.sql",
        "0408_channex_management_worker_source_scope.sql",
      ]) {
        const source = await readFile(
          new URL(`../../../packages/backend-migration/migrations/${file}`, import.meta.url),
          "utf8",
        );
        // Use the real deployed helper body without creating unrelated worker tables.
        const start = source.indexOf("CREATE FUNCTION");
        await admin.query(source.slice(start, source.indexOf("$$;", start) + 3));
      }
      for (const helper of HOTEL_SETUP_READER_RLS_HELPERS)
        await admin.query(`REVOKE ALL ON FUNCTION ${helper} FROM PUBLIC`);
      await admin.query(`CREATE POLICY worker_scope ON identity.organizations AS RESTRICTIVE
        USING(platform.channex_management_worker_source('organization',id::text))`);
      await admin.query("SAVEPOINT before_denied_read");
      await admin.query("SET SESSION AUTHORIZATION vayada_next_hotel_setup_creation_reader");
      await expect(admin.query("SELECT id FROM identity.organizations")).rejects.toMatchObject({
        code: "42501",
      });
      await admin.query("ROLLBACK TO SAVEPOINT before_denied_read");
      await admin.query("RESET SESSION AUTHORIZATION");
      for (const helper of HOTEL_SETUP_READER_RLS_HELPERS)
        await admin.query(
          `GRANT EXECUTE ON FUNCTION ${helper} TO vayada_next_hotel_setup_creation_reader`,
        );
      await admin.query("SET SESSION AUTHORIZATION vayada_next_hotel_setup_creation_reader");
      await expect(assertHotelSetupReaderRlsHelpers(admin)).resolves.toBeUndefined();
      expect((await admin.query("SELECT id FROM identity.organizations ORDER BY id")).rows).toEqual(
        [{ id: 1 }],
      );
      await admin.query("SAVEPOINT before_denied_write");
      await expect(
        admin.query("UPDATE identity.organizations SET id=3 WHERE id=1"),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query("ROLLBACK TO SAVEPOINT before_denied_write");
      await admin.query("RESET SESSION AUTHORIZATION");
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${HOTEL_SETUP_READER_RLS_HELPERS[0]}
        FROM vayada_next_hotel_setup_creation_reader`);
      await admin.query("SET SESSION AUTHORIZATION vayada_next_hotel_setup_creation_reader");
      await expect(assertHotelSetupReaderRlsHelpers(admin)).rejects.toThrow(
        "RLS helper privileges unavailable",
      );
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("RESET SESSION AUTHORIZATION");
      await admin.end();
    }
  });
});
