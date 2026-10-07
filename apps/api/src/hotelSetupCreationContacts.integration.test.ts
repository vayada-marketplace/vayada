import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { assertHotelSetupCreationScope } from "./hotelSetupCommandScope.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("native creation contact scope", () => {
  it("allows atomic new contacts, denies later or foreign writes, and preserves ordinary ACLs", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const nativeRole = `vayada_next_hotel_setup_org_${suffix}`;
    const ordinaryRole = `vay965_contacts_${suffix}`;
    const organizationId = randomUUID();
    const foreignOrganizationId = randomUUID();
    const propertyId = randomUUID();
    const foreignPropertyId = randomUUID();
    const pools: pg.Pool[] = [];
    const createdRoles: string[] = [];
    try {
      for (const role of [nativeRole, ordinaryRole]) {
        const password = randomUUID();
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        createdRoles.push(role);
        const database = new URL(url).pathname.slice(1).replaceAll('"', '""');
        await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
        await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog, identity, platform TO ${role}`);
        // Deliberately excessive test grants prove that RLS enforces the boundary.
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON
          hotel_catalog.properties, identity.organization_resource_links,
          hotel_catalog.property_locations, hotel_catalog.property_contact_channels,
          hotel_catalog.property_owner_revisions TO ${role}`);
        const connection = new URL(url);
        connection.username = role;
        connection.password = password;
        pools.push(new pg.Pool({ connectionString: connection.toString(), max: 1 }));
      }
      await admin.query(`GRANT vayada_next_hotel_setup_scope TO ${nativeRole}
        WITH INHERIT TRUE, SET FALSE`);
      for (const id of [organizationId, foreignOrganizationId])
        await admin.query(
          `INSERT INTO identity.organizations (id, kind, name, slug)
          VALUES ($1, 'hotel_group', 'Creation contacts test', $1::uuid::text)`,
          [id],
        );
      await admin.query(
        `INSERT INTO platform.hotel_setup_creation_scopes
        (database_login, organization_id) VALUES ($1, $2)`,
        [nativeRole, organizationId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties
        (id, public_id, display_name, creation_organization_id)
        VALUES ($1, $1::uuid::text, 'Foreign hotel', $2)`,
        [foreignPropertyId, foreignOrganizationId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations
        (property_id, country_code, city) VALUES ($1, 'LK', 'Foreign location')`,
        [foreignPropertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_contact_channels
        (property_id, channel_type, value, source_system)
        VALUES ($1, 'email', 'foreign@example.test', 'platform')`,
        [foreignPropertyId],
      );
      expect(
        (
          await admin.query(
            `SELECT revision FROM hotel_catalog.property_owner_revisions
        WHERE property_id = $1`,
            [foreignPropertyId],
          )
        ).rowCount,
      ).toBe(1);
      const native = pools[0]!;
      const contact = (pool: pg.Pool, id: string, value = "contact@example.test") =>
        pool.query(
          `INSERT INTO hotel_catalog.property_contact_channels
         (property_id, channel_type, value, source_system)
         VALUES ($1, 'email', $2, 'platform')`,
          [id, value],
        );
      await native.query("BEGIN");
      await assertHotelSetupCreationScope(native, organizationId);
      await expect(assertHotelSetupCreationScope(native, foreignOrganizationId)).rejects.toThrow(
        "Hotel setup creation scope preflight failed",
      );
      await native.query(
        `INSERT INTO hotel_catalog.properties
        (id, public_id, display_name, creation_organization_id)
        VALUES ($1, $1::uuid::text, 'New hotel', $2)`,
        [propertyId, organizationId],
      );
      await native.query(
        `INSERT INTO hotel_catalog.property_locations
        (property_id, country_code, city) VALUES ($1, 'LK', 'Ahangama')`,
        [propertyId],
      );
      await contact(native, propertyId);
      await native.query(
        `INSERT INTO identity.organization_resource_links
        (organization_id, product, resource_type, resource_id, relationship, status)
        VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      await native.query("COMMIT");
      expect(
        (
          await native.query(
            `SELECT value FROM hotel_catalog.property_contact_channels
        WHERE property_id = $1`,
            [propertyId],
          )
        ).rows,
      ).toEqual([{ value: "contact@example.test" }]);
      expect(
        (
          await native.query(
            `SELECT revision FROM hotel_catalog.property_owner_revisions
        WHERE property_id = $1`,
            [propertyId],
          )
        ).rows,
      ).toEqual([{ revision: "1" }]);
      await expect(contact(native, propertyId, "late@example.test")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(contact(native, foreignPropertyId)).rejects.toMatchObject({ code: "42501" });
      for (const relation of [
        "property_locations",
        "property_contact_channels",
        "property_owner_revisions",
      ]) {
        expect(
          (
            await native.query(
              `SELECT property_id FROM hotel_catalog.${relation}
          WHERE property_id = $1`,
              [foreignPropertyId],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await native.query(
              `DELETE FROM hotel_catalog.${relation}
          WHERE property_id = $1`,
              [propertyId],
            )
          ).rowCount,
        ).toBe(0);
      }
      expect(
        (
          await native.query(
            `UPDATE hotel_catalog.property_contact_channels SET value = 'changed'
        WHERE property_id = $1`,
            [propertyId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await native.query(
            `UPDATE hotel_catalog.property_owner_revisions SET revision = 99
        WHERE property_id = $1`,
            [propertyId],
          )
        ).rowCount,
      ).toBe(0);
      await contact(pools[1]!, foreignPropertyId);
      expect(
        (
          await pools[1]!.query(
            `UPDATE hotel_catalog.property_contact_channels SET value = value || '.ordinary'
        WHERE property_id = $1`,
            [foreignPropertyId],
          )
        ).rowCount,
      ).toBe(2);
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login = $1`,
        [nativeRole],
      );
      await expect(assertHotelSetupCreationScope(native, organizationId)).rejects.toThrow(
        "Hotel setup creation scope preflight failed",
      );
      expect(
        (
          await native.query(
            `SELECT value FROM hotel_catalog.property_contact_channels
        WHERE property_id = $1`,
            [propertyId],
          )
        ).rows,
      ).toEqual([]);
      await admin.query(
        `GRANT vayada_next_hotel_setup_scope TO ${ordinaryRole} WITH INHERIT TRUE, SET FALSE`,
      );
      await expect(
        contact(pools[1]!, foreignPropertyId, "unassigned@example.test"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      for (const pool of pools) {
        await pool.query("ROLLBACK").catch(() => undefined);
        await pool.end();
      }
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login = $1`,
        [nativeRole],
      );
      await admin.query(
        `DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])`,
        [[organizationId, foreignOrganizationId]],
      );
      await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
        [propertyId, foreignPropertyId],
      ]);
      await admin.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        [organizationId, foreignOrganizationId],
      ]);
      for (const role of createdRoles) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
