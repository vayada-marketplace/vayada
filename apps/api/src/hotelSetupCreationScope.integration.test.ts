import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("new hotel creation login scope", () => {
  it("allows only its assigned organization and denies direct edits", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");

    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const roles = [0, 1].map((index) => `vayada_next_hotel_setup_org_${index}_${suffix}`);
    const passwords = [randomUUID(), randomUUID()];
    const organizations = [randomUUID(), randomUUID()];
    const properties = [randomUUID(), randomUUID()];
    const prelinkedProperty = randomUUID();
    const linkedFixture = randomUUID();
    const invalidOwnerLink = `invalid-${suffix}`;
    const logins: pg.Pool[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const role = roles[index]!;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[index]}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${role}`);
        await admin.query(`GRANT USAGE ON SCHEMA identity TO ${role}`);
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON hotel_catalog.properties TO ${role}`,
        );
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON identity.organization_resource_links TO ${role}`,
        );
        await admin.query(
          `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
        );
        await admin.query(
          `INSERT INTO identity.organizations (id, kind, name, slug)
           VALUES ($1, 'hotel_group', 'Creation scope test', $2)`,
          [organizations[index], `setup-scope-${index}-${suffix}`],
        );
        await admin.query(
          `INSERT INTO platform.hotel_setup_creation_scopes (database_login, organization_id)
           VALUES ($1, $2)`,
          [role, organizations[index]],
        );
        const login = new URL(url);
        login.username = role;
        login.password = passwords[index]!;
        logins.push(new pg.Pool({ connectionString: login.toString(), max: 1 }));
      }
      await admin.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, creation_organization_id)
         VALUES ($1, $2, 'Existing linked hotel', $3)`,
        [linkedFixture, `linked-${suffix}`, organizations[0]],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizations[1], linkedFixture.toUpperCase()],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizations[1], invalidOwnerLink],
      );
      expect(
        (
          await admin.query(
            "SELECT 1 FROM platform.hotel_setup_linked_properties WHERE property_id = $1",
            [linkedFixture],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await logins[1]!.query(
            `SELECT organization_id FROM identity.organization_resource_links
             WHERE resource_id = $1`,
            [linkedFixture.toUpperCase()],
          )
        ).rows,
      ).toEqual([{ organization_id: organizations[1] }]);
      expect(
        (
          await logins[0]!.query(
            `SELECT organization_id FROM identity.organization_resource_links
             WHERE resource_id = $1`,
            [linkedFixture.toUpperCase()],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
          [organizations[0], linkedFixture],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query("SET ROLE vayada_next_hotel_setup_scope"),
      ).rejects.toMatchObject({ code: "42501" });

      for (let index = 0; index < 2; index++) {
        const row = await logins[index]!.query<{ id: string }>(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Scoped hotel', $3) RETURNING id`,
          [properties[index], `setup-property-${index}-${suffix}`, organizations[index]],
        );
        expect(row.rows[0]?.id).toBe(properties[index]);
      }

      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizations[1], prelinkedProperty.toUpperCase()],
      );
      await expect(
        logins[0]!.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Prelinked hotel', $3)`,
          [prelinkedProperty, `prelinked-${suffix}`, organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            prelinkedProperty,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[1]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            prelinkedProperty,
          ])
        ).rows,
      ).toEqual([]);

      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[0]!.query(
            "SELECT id FROM identity.organization_resource_links WHERE resource_id = $1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
          [organizations[0], properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
          [organizations[0], properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Wrong organization', $3)`,
          [randomUUID(), `wrong-${suffix}`, organizations[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name)
           VALUES ($1, $2, 'Missing organization')`,
          [randomUUID(), `missing-${suffix}`],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          "UPDATE hotel_catalog.properties SET display_name = 'Changed' WHERE id = $1",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [
            properties[0],
          ])
        ).rowCount,
      ).toBe(0);
      await admin.query("UPDATE identity.organizations SET status = 'suspended' WHERE id = $1", [
        organizations[0],
      ]);
      await expect(
        logins[0]!.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Suspended organization', $3)`,
          [randomUUID(), `suspended-${suffix}`, organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query("UPDATE identity.organizations SET status = 'active' WHERE id = $1", [
        organizations[0],
      ]);
      const linked = await logins[0]!.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')
         RETURNING product, resource_id`,
        [organizations[0], properties[0]],
      );
      expect(linked.rows).toEqual([{ product: "hotel_catalog", resource_id: properties[0] }]);
      expect(
        (
          await logins[0]!.query(
            `UPDATE identity.organization_resource_links SET status = 'suspended'
           WHERE organization_id = $1 AND resource_id = $2`,
            [organizations[0], properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query(
            "DELETE FROM identity.organization_resource_links WHERE organization_id = $1 AND resource_id = $2",
            [organizations[0], properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[0],
          ])
        ).rows,
      ).toEqual([{ id: properties[0] }]);
      await admin.query(
        `UPDATE identity.organization_resource_links SET status = 'suspended'
         WHERE organization_id = $1 AND resource_id = $2`,
        [organizations[0], properties[0]],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [organizations[1], properties[0]],
      );
      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[0],
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[1]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[0],
          ])
        ).rows,
      ).toEqual([{ id: properties[0] }]);
      await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id = $1", [
        properties[0],
      ]);
      expect(
        (
          await admin.query(
            "SELECT 1 FROM platform.hotel_setup_linked_properties WHERE property_id = $1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[0],
          ])
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
          [organizations[0], properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(`REVOKE vayada_next_hotel_setup_scope FROM ${roles[1]}`);
      expect(
        (
          await logins[1]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await admin.query(`GRANT ${roles[1]} TO ${roles[0]} WITH INHERIT FALSE, SET TRUE`);
      await logins[0]!.query(`SET ROLE ${roles[1]}`);
      expect(
        (
          await logins[0]!.query("SELECT id FROM hotel_catalog.properties WHERE id = $1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Switched role', $3)`,
          [randomUUID(), `switched-${suffix}`, organizations[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await logins[0]!.query("RESET ROLE");
      await admin.query(`REVOKE ${roles[1]} FROM ${roles[0]}`);
    } finally {
      await Promise.all(logins.map((login) => login.end()));
      await admin.query(
        "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login = ANY($1::name[])",
        [roles],
      );
      await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id = $1", [
        properties[0],
      ]);
      await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id = $1", [
        prelinkedProperty.toUpperCase(),
      ]);
      await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id = $1", [
        linkedFixture.toUpperCase(),
      ]);
      await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id = $1", [
        invalidOwnerLink,
      ]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [...properties, prelinkedProperty, linkedFixture],
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        organizations,
      ]);
      for (const role of roles) {
        await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
