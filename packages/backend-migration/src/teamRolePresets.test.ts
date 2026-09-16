import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env["TEST_DATABASE_URL"];
it.skipIf(!url)("seeds account roles once without changing legacy access", async () => {
  assertSafeTestDatabase(url!);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const existing = "14390000-0000-4000-8000-000000000001";
  const fresh = "14390000-0000-4000-8000-000000000002";
  const other = "14390000-0000-4000-8000-000000000003";
  try {
    await client.query(`BEGIN;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY, kind TEXT);
      CREATE TABLE identity.organization_memberships (id INT PRIMARY KEY, organization_id UUID, permission_overrides JSONB);
      CREATE TABLE identity.staff_invitations (id INT PRIMARY KEY, organization_id UUID);`);
    await client.query(
      await readFile(
        new URL("../migrations/0202_organization_role_definitions.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("INSERT INTO identity.organizations VALUES ($1, 'hotel_group')", [existing]);
    await client.query(
      `INSERT INTO identity.organization_memberships VALUES (1, $1, '{"grant":["pms.calendar.manage"]}', NULL)`,
      [existing],
    );
    await client.query("INSERT INTO identity.staff_invitations VALUES (1, $1, NULL)", [existing]);
    await client.query(
      await readFile(new URL("../migrations/0203_team_role_presets.sql", import.meta.url), "utf8"),
    );
    await client.query(
      "INSERT INTO identity.organizations VALUES ($1, 'hotel_group'), ($2, 'creator')",
      [fresh, other],
    );
    for (const org of [existing, fresh]) {
      const roles = (
        await client.query(
          "SELECT preset_key, default_permissions FROM identity.organization_roles WHERE organization_id = $1 ORDER BY preset_key",
          [org],
        )
      ).rows;
      expect(roles.map((role) => role.preset_key)).toEqual([
        "account_admin",
        "agency_manager",
        "front_desk",
        "housekeeping",
        "property_owner",
        "reservation_manager",
      ]);
      expect(
        roles
          .find((role) => role.preset_key === "property_owner")
          .default_permissions.every((key: string) => key.endsWith(".read")),
      ).toBe(true);
      expect(
        roles.find((role) => role.preset_key === "housekeeping").default_permissions,
      ).not.toContain("pms.guest_contact.read");
    }
    expect(
      (
        await client.query("SELECT * FROM identity.organization_roles WHERE organization_id = $1", [
          other,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query(
          "SELECT role_definition_id, permission_overrides FROM identity.organization_memberships",
        )
      ).rows,
    ).toEqual([
      { role_definition_id: null, permission_overrides: { grant: ["pms.calendar.manage"] } },
    ]);
    expect(
      (await client.query("SELECT role_definition_id FROM identity.staff_invitations")).rows,
    ).toEqual([{ role_definition_id: null }]);
    await client.query("SAVEPOINT immutable");
    await expect(
      client.query(
        "DELETE FROM identity.organization_roles WHERE organization_id = $1 AND preset_key = 'account_admin'",
        [existing],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT immutable");
    await client.query(
      "DELETE FROM identity.organization_roles WHERE organization_id = $1 AND preset_key = 'front_desk'",
      [existing],
    );
    await client.query("UPDATE identity.organizations SET kind = kind WHERE id = $1", [existing]);
    expect(
      (
        await client.query("SELECT * FROM identity.organization_roles WHERE organization_id = $1", [
          existing,
        ])
      ).rowCount,
    ).toBe(5);
    await client.query("DELETE FROM identity.organizations WHERE id = $1", [fresh]);
    expect(
      (
        await client.query("SELECT * FROM identity.organization_roles WHERE organization_id = $1", [
          fresh,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
