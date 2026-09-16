import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env["TEST_DATABASE_URL"];
it.skipIf(!url)(
  "preserves legacy Settings capabilities while separating Add-ons and Promos",
  async () => {
    assertSafeTestDatabase(url!);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`BEGIN;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.permission_catalog (key TEXT PRIMARY KEY, product TEXT, description TEXT);
      CREATE TABLE identity.role_permission_grants (organization_kind TEXT, role_key TEXT, permission_key TEXT, UNIQUE(organization_kind, role_key, permission_key));
      CREATE TABLE identity.organization_memberships (id INT, permission_overrides JSONB, updated_at TIMESTAMPTZ);
      CREATE TABLE identity.staff_invitations (LIKE identity.organization_memberships);
      INSERT INTO identity.role_permission_grants VALUES ('hotel_group', 'hotel_manager', 'booking.settings.manage'), ('hotel_group', 'front_desk', 'booking.settings.read');
      INSERT INTO identity.organization_memberships VALUES
        (1, '{"grant":["booking.settings.manage","booking.settings.read"],"deny":[]}', now()),
        (2, '{"grant":[],"deny":["booking.settings.manage"]}', now()),
        (3, NULL, now()),
        (4, '{"grant":"booking.settings.manage","deny":[]}', now()),
        (5, '{"grant":["booking.settings.manage","booking.settings.read","booking.settings.read"],"deny":[]}', now()),
        (6, '{"grant":[],"deny":["booking.settings.manage","booking.settings.manage"]}', now());
      INSERT INTO identity.staff_invitations SELECT * FROM identity.organization_memberships;`);
      await client.query(
        await readFile(
          new URL("../migrations/0200_booking_addon_promo_permissions.sql", import.meta.url),
          "utf8",
        ),
      );
      const added = [
        "booking.addons.manage",
        "booking.addons.read",
        "booking.promos.manage",
        "booking.promos.read",
      ];
      const roles = await client.query(
        "SELECT role_key, permission_key FROM identity.role_permission_grants WHERE permission_key <> ALL($1::text[]) ORDER BY permission_key",
        [["booking.settings.manage", "booking.settings.read"]],
      );
      expect(roles.rows).toEqual(
        added.map((permission_key) => ({ role_key: "hotel_manager", permission_key })),
      );
      for (const table of ["organization_memberships", "staff_invitations"]) {
        const rows = await client.query(
          `SELECT permission_overrides FROM identity.${table} ORDER BY id`,
        );
        expect(rows.rows.map((row) => row.permission_overrides)).toEqual([
          { grant: [...added, "booking.settings.manage", "booking.settings.read"], deny: [] },
          { grant: [], deny: [...added, "booking.settings.manage"] },
          null,
          { grant: "booking.settings.manage", deny: [] },
          {
            grant: ["booking.settings.manage", "booking.settings.read", "booking.settings.read"],
            deny: [],
          },
          { grant: [], deny: ["booking.settings.manage", "booking.settings.manage"] },
        ]);
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
