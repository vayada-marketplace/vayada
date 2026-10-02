import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertHotelSetupServiceReader } from "./hotelSetupCommandServiceConfig.js";
import {
  assertHotelSetupReaderPrivileges,
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
  HOTEL_SETUP_CREATION_READER_READ_COLUMNS,
} from "./hotelSetupReaderPrivileges.js";

const modes = ["property_commands", "property_creation"] as const;
const connectionString = process.env.HOTEL_SETUP_READER_TEST_DATABASE_URL;

describe.runIf(connectionString)("private reader effective ACL on migrated PostgreSQL", () => {
  it.each(modes)("exact reader ACL: %s", async (mode) => {
    // Explicit disposable local database only; every role, grant and object rolls back.
    if (
      !connectionString ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)
    )
      throw new Error("Hotel setup reader fixture requires a disposable local database");
    const client = new pg.Client({ connectionString });
    await client.connect();
    const reader =
      mode === "property_creation"
        ? "vayada_next_hotel_setup_creation_reader"
        : "vayada_next_hotel_setup_reader";
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${reader} LOGIN NOINHERIT`);
      await client.query(`GRANT USAGE ON SCHEMA identity,platform TO ${reader}`);
      for (const [relation, columns] of Object.entries(
        mode === "property_creation"
          ? HOTEL_SETUP_CREATION_READER_READ_COLUMNS
          : HOTEL_SETUP_READER_READ_COLUMNS,
      ))
        await client.query(`GRANT SELECT (${columns.join(",")}) ON ${relation} TO ${reader}`);
      await client.query(
        `GRANT INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")}) ON platform.product_audit_events TO ${reader}`,
      );
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      await assertHotelSetupServiceReader(client, mode);
      await expect(assertHotelSetupReaderPrivileges(client, mode)).resolves.toBeUndefined();
      await client.query("RESET SESSION AUTHORIZATION");

      const changes = [
        `GRANT SELECT (id) ON identity.users TO ${reader} WITH GRANT OPTION`,
        `GRANT UPDATE (status) ON identity.product_entitlements TO ${reader}`,
        `GRANT INSERT ON platform.product_audit_events TO ${reader}`,
        `GRANT SELECT (private_payload) ON platform.product_audit_events TO ${reader}`,
        `GRANT DELETE ON platform.product_audit_events TO ${reader}`,
        `GRANT CREATE ON SCHEMA public TO ${reader}`,
        `REVOKE SELECT (id) ON identity.users FROM ${reader}`,
        "CREATE TABLE platform.vay1092_reader_acl_probe(payload text); GRANT SELECT ON platform.vay1092_reader_acl_probe TO PUBLIC",
        "CREATE TABLE platform.vay1092_reader_acl_probe(); GRANT INSERT ON platform.vay1092_reader_acl_probe TO PUBLIC",
        "CREATE TABLE platform.vay1092_reader_acl_probe(); GRANT SELECT ON platform.vay1092_reader_acl_probe TO PUBLIC",
        "CREATE SEQUENCE platform.vay1092_reader_acl_sequence; GRANT USAGE ON SEQUENCE platform.vay1092_reader_acl_sequence TO PUBLIC",
        "CREATE FUNCTION platform.vay1092_reader_acl_function() RETURNS integer LANGUAGE SQL SECURITY DEFINER AS 'SELECT 1'",
      ];
      const version = await client.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      if (version.rows[0]!.version >= 170000)
        changes.push(`GRANT MAINTAIN ON platform.product_audit_events TO ${reader}`);
      for (const sql of changes) {
        await client.query("SAVEPOINT drift");
        await client.query(sql);
        await client.query(`SET SESSION AUTHORIZATION ${reader}`);
        await expect(assertHotelSetupReaderPrivileges(client, mode), sql).rejects.toThrow(
          /Hotel setup/,
        );
        await client.query("RESET SESSION AUTHORIZATION");
        await client.query("ROLLBACK TO SAVEPOINT drift");
      }
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  });
});
