import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env["TEST_DATABASE_URL"];
it.skipIf(!url)(
  "enforces tenant role references, immutable classes and reserved admin roles",
  async () => {
    assertSafeTestDatabase(url!);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const org = "14390000-0000-4000-8000-000000000001";
    const foreign = "14390000-0000-4000-8000-000000000002";
    async function rejects(sql: string, values: unknown[], code: string) {
      await client.query("SAVEPOINT rejected_write");
      await expect(client.query(sql, values)).rejects.toMatchObject({ code });
      await client.query("ROLLBACK TO SAVEPOINT rejected_write");
    }
    try {
      await client.query(`BEGIN;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.organization_memberships (id INT PRIMARY KEY, organization_id UUID);
      CREATE TABLE identity.staff_invitations (id INT PRIMARY KEY, organization_id UUID);`);
      await client.query(
        await readFile(
          new URL("../migrations/0202_organization_role_definitions.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("INSERT INTO identity.organizations VALUES ($1), ($2)", [org, foreign]);
      const role = (
        await client.query(
          `INSERT INTO identity.organization_roles (organization_id, name, security_class, base_role_key, default_permissions) VALUES ($1, 'Night shift', 'staff', 'hotel_custom', '[]') RETURNING id`,
          [org],
        )
      ).rows[0].id;
      for (const table of ["organization_memberships", "staff_invitations"]) {
        await client.query(
          `INSERT INTO identity.${table} (id, organization_id, role_definition_id) VALUES (1, $1, $2)`,
          [org, role],
        );
        await rejects(
          `INSERT INTO identity.${table} (id, organization_id, role_definition_id) VALUES (2, $1, $2)`,
          [foreign, role],
          "23503",
        );
      }
      await rejects("DELETE FROM identity.organization_roles WHERE id = $1", [role], "23503");
      await rejects(
        "UPDATE identity.organization_roles SET security_class = 'account_admin', base_role_key = 'hotel_owner', preset_key = 'account_admin' WHERE id = $1",
        [role],
        "23514",
      );
      await client.query(
        "UPDATE identity.organization_roles SET name = 'Evening shift' WHERE id = $1",
        [role],
      );
      expect(
        (
          await client.query(
            "SELECT revision::int, security_class FROM identity.organization_roles WHERE id = $1",
            [role],
          )
        ).rows[0],
      ).toEqual({ revision: 2, security_class: "staff" });
      await rejects(
        `INSERT INTO identity.organization_roles (organization_id, name, security_class, base_role_key, default_permissions) VALUES ($1, 'Fake admin', 'account_admin', 'hotel_owner', '[]')`,
        [org],
        "23514",
      );
      await rejects(
        `INSERT INTO identity.organization_roles (organization_id, name, security_class, base_role_key, preset_key, default_permissions) VALUES ($1, 'Fake owner', 'staff', 'front_desk', 'property_owner', '[]')`,
        [org],
        "23514",
      );
      const admin = (
        await client.query(
          `INSERT INTO identity.organization_roles (organization_id, name, security_class, base_role_key, preset_key, default_permissions) VALUES ($1, 'Account admin', 'account_admin', 'hotel_owner', 'account_admin', '[]') RETURNING id`,
          [org],
        )
      ).rows[0].id;
      await rejects(
        "UPDATE identity.organization_roles SET name = 'Renamed' WHERE id = $1",
        [admin],
        "23514",
      );
      await rejects("DELETE FROM identity.organization_roles WHERE id = $1", [admin], "23514");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
