import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const connectionString = process.env["TEST_DATABASE_URL"];
const role = "vayada_next_api_runtime";
// VAY-2054: the six identity tables the ordinary API locks but never writes.
const lockTables = [
  "identity.organizations",
  "identity.users",
  "identity.organization_memberships",
  "identity.role_permission_grants",
  "identity.membership_property_assignments",
  "identity.organization_roles",
];

describe.skipIf(!connectionString)("API runtime identity lock-only policies (0475)", () => {
  const password = randomUUID();
  const otherRole = `vayada_test_identity_writer_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const ids = {
    organization: randomUUID(),
    user: randomUUID(),
    membership: randomUUID(),
    grant: randomUUID(),
    property: randomUUID(),
    organizationRole: randomUUID(),
  };
  let admin: pg.Client;
  let runtime: pg.Client;
  let other: pg.Client;
  let createdRole = false;

  const connectAs = async (login: string, secret: string) => {
    const url = new URL(connectionString!);
    url.username = login;
    url.password = secret;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  };
  const lockColumn = async (table: string) =>
    (
      await admin.query<{ attname: string }>(
        `SELECT attribute.attname FROM pg_index AS index
           JOIN pg_attribute AS attribute ON attribute.attrelid = index.indrelid AND attribute.attnum = index.indkey[0]
          WHERE index.indrelid = $1::regclass AND index.indisprimary`,
        [table],
      )
    ).rows[0]!.attname;

  beforeAll(async () => {
    assertSafeTestDatabase(connectionString!);
    const migrations = await runMigrations({
      connectionString: connectionString!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(migrations.failed).toBeNull();
    admin = new pg.Client({ connectionString });
    await admin.connect();
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    createdRole = existing.rowCount === 0;
    if (createdRole) {
      await admin.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }
    await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${otherRole} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
    const database = new URL(connectionString!).pathname.slice(1);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}, ${otherRole}`);
    await admin.query(`GRANT USAGE ON SCHEMA identity TO ${role}, ${otherRole}`);
    // Existing policies on these tables read other identity, platform and catalog rows.
    await admin.query(`GRANT USAGE ON SCHEMA platform, hotel_catalog TO ${otherRole}`);
    await admin.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA identity, platform, hotel_catalog TO ${otherRole}`,
    );
    for (const table of lockTables) {
      await admin.query(
        `GRANT SELECT, UPDATE ("${await lockColumn(table)}") ON ${table} TO ${role}`,
      );
      await admin.query(`GRANT SELECT, UPDATE ON ${table} TO ${otherRole}`);
    }
    const permission = (
      await admin.query<{ key: string }>(
        "SELECT key FROM identity.permission_catalog ORDER BY key LIMIT 1",
      )
    ).rows[0]!.key;
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1, 'hotel_group', 'Lock fixture', $2)`,
        [ids.organization, `lock-fixture-${ids.organization.slice(0, 8)}`],
      );
      await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        ids.user,
        `lock-${ids.user.slice(0, 8)}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, role_key, status, property_access_mode, access_origin)
       VALUES ($1, $2, $3, 'hotel_owner', 'active', 'assigned', 'agency')`,
        [ids.membership, ids.organization, ids.user],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants (id, organization_kind, role_key, permission_key)
       VALUES ($1, 'hotel_group', $2, $3)`,
        [ids.grant, `lock_fixture_${ids.grant.slice(0, 8)}`, permission],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, $2, 'Lock fixture')`,
        [ids.property, `lock-fixture-${ids.property.slice(0, 8)}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2::text, 'owner', 'active')`,
        [ids.organization, ids.property],
      );
      await admin.query(
        `INSERT INTO identity.membership_property_assignments (membership_id, property_id) VALUES ($1, $2)`,
        [ids.membership, ids.property],
      );
      await admin.query(
        `INSERT INTO identity.organization_roles (id, organization_id, name, security_class, base_role_key, default_permissions)
       VALUES ($1, $2, 'Lock fixture role', 'staff', 'hotel_custom', '[]'::jsonb)`,
        [ids.organizationRole, ids.organization],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    runtime = await connectAs(role, password);
    other = await connectAs(otherRole, password);
  }, 180_000);

  afterAll(async () => {
    await runtime?.end().catch(() => undefined);
    await other?.end().catch(() => undefined);
    if (!admin) return;
    await admin.query("DELETE FROM identity.organization_roles WHERE id = $1", [
      ids.organizationRole,
    ]);
    await admin.query(
      "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1",
      [ids.membership],
    );
    await admin.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id = $1 AND resource_id = $2::text",
      [ids.organization, ids.property],
    );
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [ids.property]);
    await admin.query("DELETE FROM identity.role_permission_grants WHERE id = $1", [ids.grant]);
    await admin.query("DELETE FROM identity.organization_memberships WHERE id = $1", [
      ids.membership,
    ]);
    await admin.query("DELETE FROM identity.users WHERE id = $1", [ids.user]);
    await admin.query("DELETE FROM identity.organizations WHERE id = $1", [ids.organization]);
    await admin.query(`DROP OWNED BY ${otherRole}`);
    await admin.query(`DROP ROLE ${otherRole}`);
    if (createdRole) {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.end();
  }, 30_000);

  it("installs a restrictive lock-only UPDATE policy on every lock table", async () => {
    const policies = await admin.query<{
      relation: string;
      permissive: boolean;
      cmd: string;
      check: string;
    }>(
      `SELECT polrelid::regclass::text AS relation, polpermissive AS permissive, polcmd AS cmd,
              pg_get_expr(polwithcheck, polrelid) AS check
         FROM pg_policy WHERE polname = 'api_runtime_lock_only' ORDER BY 1`,
    );
    expect(policies.rows.map((row) => row.relation).sort()).toEqual([...lockTables].sort());
    for (const row of policies.rows) {
      expect(row.permissive).toBe(false);
      expect(row.cmd).toBe("w");
      expect(row.check).toContain(`'${role}'`);
    }
    const rls = await admin.query<{ relation: string; enabled: boolean; permissive: number }>(
      `SELECT relation.name AS relation, table_info.relrowsecurity AS enabled,
              (SELECT count(*) FROM pg_policy WHERE polrelid = table_info.oid AND polpermissive)::int AS permissive
         FROM unnest($1::text[]) AS relation(name)
         JOIN pg_class AS table_info ON table_info.oid = to_regclass(relation.name)`,
      [lockTables],
    );
    for (const row of rls.rows) {
      expect(row.enabled, row.relation).toBe(true);
      expect(row.permissive, row.relation).toBeGreaterThan(0);
    }
  });

  it("lets the API login take row locks but rejects every update it attempts", async () => {
    const rows: Record<string, [string, string]> = {
      "identity.organizations": ["id", ids.organization],
      "identity.users": ["id", ids.user],
      "identity.organization_memberships": ["id", ids.membership],
      "identity.role_permission_grants": ["id", ids.grant],
      "identity.membership_property_assignments": ["membership_id", ids.membership],
      "identity.organization_roles": ["id", ids.organizationRole],
    };
    for (const table of lockTables) {
      const [column, value] = rows[table]!;
      for (const mode of ["FOR SHARE", "FOR KEY SHARE", "FOR UPDATE", "FOR NO KEY UPDATE"]) {
        await runtime.query("BEGIN");
        const locked = await runtime.query(
          `SELECT ${column} FROM ${table} WHERE ${column} = $1::uuid ${mode}`,
          [value],
        );
        await runtime.query("ROLLBACK");
        expect(locked.rowCount, `${table} ${mode}`).toBe(1);
      }
      const lock = await lockColumn(table);
      await expect(
        runtime.query(`UPDATE ${table} SET ${lock} = ${lock} WHERE ${column} = $1::uuid`, [value]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.query(`UPDATE ${table} SET created_at = created_at WHERE ${column} = $1::uuid`, [
          value,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("keeps updates for the owner and for other logins with real UPDATE grants", async () => {
    const owner = await admin.query(
      "UPDATE identity.organizations SET created_at = created_at WHERE id = $1::uuid",
      [ids.organization],
    );
    expect(owner.rowCount).toBe(1);
    const writer = await other.query(
      "UPDATE identity.users SET created_at = created_at WHERE id = $1::uuid",
      [ids.user],
    );
    expect(writer.rowCount).toBe(1);
    const assignment = await other.query(
      "UPDATE identity.membership_property_assignments SET created_at = created_at WHERE membership_id = $1::uuid",
      [ids.membership],
    );
    expect(assignment.rowCount).toBe(1);
  });
});
