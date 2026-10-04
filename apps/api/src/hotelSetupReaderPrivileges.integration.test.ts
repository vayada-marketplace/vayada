import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createHotelSetupCreationCredentialResolver,
  createHotelSetupCredentialResolver,
} from "./hotelSetupCommandCredentials.js";
import { assertHotelSetupServiceReader } from "./hotelSetupCommandServiceConfig.js";
import {
  assertHotelSetupReaderPrivileges,
  assertHotelSetupCredentialReadinessSchema,
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
  HOTEL_SETUP_CREATION_READER_READ_COLUMNS,
} from "./hotelSetupReaderPrivileges.js";

const modes = ["property_commands", "property_creation"] as const;
const connectionString = process.env.HOTEL_SETUP_READER_TEST_DATABASE_URL;
const readinessColumns = [
  "credential_role_oid",
  "credential_secret_version",
  "credential_ready_at",
] as const;

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
    const registry =
      mode === "property_creation"
        ? "platform.hotel_setup_creation_scopes"
        : "platform.hotel_setup_property_scopes";
    const readinessConstraint =
      mode === "property_creation"
        ? "hotel_setup_creation_credential_ready"
        : "hotel_setup_property_credential_ready";
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
      await client.query(`SELECT ${readinessColumns.join(",")} FROM ${registry}`);
      await client.query("RESET SESSION AUTHORIZATION");

      const constraint = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid=$1::regclass AND conname=$2`,
        [registry, readinessConstraint],
      );
      expect(constraint.rows).toHaveLength(1);
      const schemaChanges = [
        ...readinessColumns.flatMap((column, index) => [
          `ALTER TABLE ${registry} DROP COLUMN ${column}`,
          `ALTER TABLE ${registry} ALTER COLUMN ${column} TYPE ${["bigint", "varchar", "timestamp"][index]}`,
          `ALTER TABLE ${registry} ALTER COLUMN ${column} SET NOT NULL`,
        ]),
        `ALTER TABLE ${registry} DROP CONSTRAINT ${readinessConstraint}`,
        `ALTER TABLE ${registry} RENAME CONSTRAINT ${readinessConstraint} TO readiness_unreviewed`,
        `ALTER TABLE ${registry} DROP CONSTRAINT ${readinessConstraint}; ALTER TABLE ${registry} ADD CONSTRAINT ${readinessConstraint} CHECK (TRUE)`,
        `ALTER TABLE ${registry} DROP CONSTRAINT ${readinessConstraint}; ALTER TABLE ${registry} ADD CONSTRAINT ${readinessConstraint} ${constraint.rows[0]!.definition} NOT VALID`,
      ];
      for (const sql of schemaChanges) {
        await client.query("SAVEPOINT schema_drift");
        await client.query(sql);
        await client.query(`SET SESSION AUTHORIZATION ${reader}`);
        await expect(assertHotelSetupCredentialReadinessSchema(client), sql).rejects.toThrow(
          /Hotel setup/,
        );
        await client.query("RESET SESSION AUTHORIZATION");
        await client.query("ROLLBACK TO SAVEPOINT schema_drift");
      }

      const changes = [
        ...readinessColumns.flatMap((column) => [
          `REVOKE SELECT (${column}) ON ${registry} FROM ${reader}`,
          `GRANT UPDATE (${column}) ON ${registry} TO ${reader}`,
          `GRANT SELECT (${column}) ON ${registry} TO ${reader} WITH GRANT OPTION`,
        ]),
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

      const organizationId = randomUUID();
      const propertyId = randomUUID();
      const login =
        mode === "property_creation"
          ? "vayada_next_hotel_setup_org_readiness_fixture"
          : "vayada_next_hotel_setup_property_readiness_fixture";
      await client.query(
        `INSERT INTO identity.organizations(id,kind,name,slug)
         VALUES($1,'hotel_group','Readiness fixture',$1::uuid::text)`,
        [organizationId],
      );
      if (mode === "property_commands")
        await client.query(
          `INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id)
           VALUES($1,$1::uuid::text,'Readiness fixture',$2)`,
          [propertyId, organizationId],
        );
      await client.query(
        mode === "property_creation"
          ? `INSERT INTO ${registry}(database_login,organization_id) VALUES($1,$2)`
          : `INSERT INTO ${registry}(database_login,organization_id,property_id,operation_class)
             VALUES($1,$2,$3,'launch_settings')`,
        mode === "property_creation"
          ? [login, organizationId]
          : [login, organizationId, propertyId],
      );
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      expect(
        (await client.query(`SELECT ${readinessColumns.join(",")} FROM ${registry}`)).rows,
      ).toEqual([
        { credential_role_oid: null, credential_secret_version: null, credential_ready_at: null },
      ]);
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query(`CREATE ROLE ${login} LOGIN NOINHERIT`);
      const role = await client.query<{ oid: number }>(
        "SELECT oid FROM pg_roles WHERE rolname=$1",
        [login],
      );
      if (mode === "property_commands")
        await client.query(
          `INSERT INTO identity.organization_resource_links
          (organization_id,product,resource_type,resource_id,relationship,status)
          VALUES ($1,'hotel_catalog','property',$2,'owner','active'),
            ($1,'pms','pms_property',$2,'owner','active')`,
          [organizationId, propertyId],
        );
      const ready = [role.rows[0]!.oid, "a".repeat(32), new Date().toISOString()];
      const updateReadiness = (values: readonly unknown[]) =>
        client.query(
          `UPDATE ${registry} SET credential_role_oid=$2,credential_secret_version=$3,
           credential_ready_at=$4 WHERE database_login=$1`,
          [login, ...values],
        );
      const invalid = [
        ...Array.from({ length: 6 }, (_, index) =>
          ready.map((value, bit) => ((index + 1) & (1 << bit) ? value : null)),
        ),
        ...["a".repeat(31), "a".repeat(65), "!".repeat(32)].map((version) => [
          ready[0],
          version,
          ready[2],
        ]),
      ];
      for (const values of invalid) {
        await client.query("SAVEPOINT partial_readiness");
        await expect(updateReadiness(values), JSON.stringify(values)).rejects.toMatchObject({
          code: "23514",
          constraint: readinessConstraint,
        });
        await client.query("ROLLBACK TO SAVEPOINT partial_readiness");
      }
      expect((await updateReadiness(ready)).rowCount).toBe(1);
      expect((await updateReadiness([ready[0], "a".repeat(63) + "-", ready[2]])).rowCount).toBe(1);
      expect((await updateReadiness([null, null, null])).rowCount).toBe(1);
      const readNativeSecret = vi
        .fn()
        .mockResolvedValue({ username: login, password: "p".repeat(48) });
      const options = {
        assignments: client,
        readNativeSecret,
        databaseEndpoint: "postgresql://database.internal/target",
        secretPrefix: `hotel-setup-command/prod/${mode === "property_creation" ? "organization" : "property"}/`,
      };
      const resolve =
        mode === "property_creation"
          ? () => createHotelSetupCreationCredentialResolver(options)(organizationId)
          : () =>
              createHotelSetupCredentialResolver(options, "launch_settings")(
                propertyId,
                organizationId,
              );
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      await expect(resolve()).rejects.toThrow("assignment");
      expect(readNativeSecret).not.toHaveBeenCalled();
      await client.query("RESET SESSION AUTHORIZATION");
      await updateReadiness(ready);
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      expect(new URL(await resolve()).username).toBe(login);
      expect(readNativeSecret).toHaveBeenCalledWith(options.secretPrefix + login, ready[1]);
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query(`DROP ROLE ${login}`);
      await client.query(`CREATE ROLE ${login} LOGIN NOINHERIT`);
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      await expect(resolve()).rejects.toThrow("assignment");
      expect(readNativeSecret).toHaveBeenCalledOnce();
      await client.query("RESET SESSION AUTHORIZATION");
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  });
});
