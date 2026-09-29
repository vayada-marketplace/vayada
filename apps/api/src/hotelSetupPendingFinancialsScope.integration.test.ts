import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("new hotel pending Financials scope", () => {
  it("permits only the assigned organization's pending PMS row and no direct edits", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");

    const admin = new pg.Client({ connectionString: url });
    const suffix = randomUUID().replaceAll("-", "");
    const roles = [0, 1].map((index) => `vayada_next_hotel_setup_org_${index}_${suffix}`);
    const passwords = [randomUUID(), randomUUID()];
    const organizations = [randomUUID(), randomUUID()];
    const properties = [randomUUID(), randomUUID()];
    const legacyProperty = randomUUID();
    const unlinkedProperty = randomUUID();
    const logins: pg.Client[] = [];
    const createdRoles: string[] = [];
    const insertPending = `INSERT INTO identity.product_entitlements (
      organization_id, product, entitlement_key, status, resource_product,
      resource_type, resource_id, metadata
    ) VALUES ($1, 'pms', 'module:financials', $3, 'pms',
      'pms_property', $2, $4::jsonb) RETURNING id`;
    const pending = { newHotelFinancialsDefault: "pending" };

    await admin.connect();
    try {
      for (let index = 0; index < 2; index++) {
        await admin.query(
          `INSERT INTO identity.organizations (id, kind, name, slug)
           VALUES ($1, 'hotel_group', 'Pending Financials test', $2)`,
          [organizations[index], `pending-financials-${index}-${suffix}`],
        );
        const role = roles[index]!;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[index]}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        createdRoles.push(role);
        await admin.query(`GRANT USAGE ON SCHEMA identity, hotel_catalog, platform TO ${role}`);
        // Intentionally broad test ACLs: the RLS boundary must still deny edits.
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON identity.product_entitlements TO ${role}`,
        );
        await admin.query(
          `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
        );
        await admin.query(
          `INSERT INTO platform.hotel_setup_creation_scopes (database_login, organization_id)
           VALUES ($1, $2)`,
          [role, organizations[index]],
        );
        const loginUrl = new URL(url);
        loginUrl.username = role;
        loginUrl.password = passwords[index]!;
        const login = new pg.Client({ connectionString: loginUrl.toString() });
        await login.connect();
        logins.push(login);
        await admin.query(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Pending Financials hotel', $3)`,
          [properties[index], `pending-${index}-${suffix}`, organizations[index]],
        );
        await admin.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active'),
                  ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
          [organizations[index], properties[index]],
        );
        await admin.query(
          `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, status)
           VALUES ($1, 'pms', 'property-management', 'active')`,
          [organizations[index]],
        );
      }
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, $2, 'Legacy hotel')`,
        [legacyProperty, `legacy-${suffix}`],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, creation_organization_id)
         VALUES ($1, $2, 'Hotel without PMS', $3)`,
        [unlinkedProperty, `unlinked-${suffix}`, organizations[0]],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active'),
                ($1, 'pms', 'pms_property', $2, 'owner', 'active'),
                ($1, 'hotel_catalog', 'property', $3, 'owner', 'active')`,
        [organizations[0], legacyProperty, unlinkedProperty],
      );

      for (const [organizationId, propertyId, status, metadata] of [
        [organizations[1], properties[1], "suspended", pending],
        [organizations[0], properties[1], "suspended", pending],
        [organizations[0], legacyProperty, "suspended", pending],
        [organizations[0], unlinkedProperty, "suspended", pending],
        [organizations[0], properties[0], "active", pending],
        [organizations[0], properties[0], "suspended", { newHotelFinancialsDefault: "ready" }],
        [organizations[0], properties[0], "suspended", { ...pending, forged: true }],
      ] as const) {
        await expect(
          logins[0]!.query(insertPending, [organizationId, propertyId, status, metadata]),
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect(
        (
          await logins[0]!.query(insertPending, [
            organizations[0],
            properties[0],
            "suspended",
            pending,
          ])
        ).rowCount,
      ).toBe(1);
      await admin.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status)
         VALUES ($1, 'platform', 'unrelated', 'active')`,
        [organizations[0]],
      );
      await admin.query(insertPending, [organizations[0], legacyProperty, "suspended", pending]);
      expect(
        (
          await logins[0]!.query(
            `SELECT id FROM identity.product_entitlements
             WHERE organization_id=$1 AND entitlement_key='unrelated'`,
            [organizations[0]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[0]!.query(
            `SELECT id FROM identity.product_entitlements
             WHERE organization_id=$1 AND resource_id=$2`,
            [organizations[0], legacyProperty],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, status)
           VALUES ($1, 'pms', 'property-management', 'active')`,
          [organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `UPDATE identity.product_entitlements SET status='active'
           WHERE organization_id=$1 AND resource_id=$2`,
          [organizations[0], properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `UPDATE identity.product_entitlements
           SET metadata='{"newHotelFinancialsDefault":"ready"}'::jsonb
           WHERE organization_id=$1 AND resource_id=$2`,
          [organizations[0], properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            `DELETE FROM identity.product_entitlements
           WHERE organization_id=$1 AND resource_id=$2`,
            [organizations[0], properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query(
            `SELECT id FROM identity.product_entitlements WHERE organization_id=$1`,
            [organizations[1]],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        logins[0]!.query("SET ROLE vayada_next_hotel_setup_scope"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await admin.query(
            `SELECT status, metadata FROM identity.product_entitlements
           WHERE organization_id=$1 AND resource_id=$2`,
            [organizations[0], properties[0]],
          )
        ).rows,
      ).toEqual([{ status: "suspended", metadata: pending }]);
    } finally {
      await Promise.all(logins.map((login) => login.end()));
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id = ANY($1::uuid[])",
        [organizations],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])",
        [organizations],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [...properties, legacyProperty, unlinkedProperty],
      ]);
      await admin.query(
        "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login = ANY($1::name[])",
        [createdRoles],
      );
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        organizations,
      ]);
      for (const role of createdRoles) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
