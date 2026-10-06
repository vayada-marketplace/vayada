import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("native creation product scopes", () => {
  it("reads only its own setup state and denies billing, track, and existing product changes", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const role = `vayada_next_hotel_setup_org_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    const organizations = [randomUUID(), randomUUID()];
    const properties = [randomUUID(), randomUUID()];
    const billing = [randomUUID(), randomUUID()];
    const newProperties: string[] = [];
    let native: pg.Pool | undefined;
    let created = false;
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      created = true;
      const database = new URL(url).pathname.slice(1).replaceAll('"', '""');
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
      await admin.query(
        `GRANT USAGE ON SCHEMA hotel_catalog, identity, platform, booking, marketplace, finance TO ${role}`,
      );
      await admin.query(
        `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON hotel_catalog.properties, identity.organization_resource_links TO ${role}`,
      );
      // Excessive fixture grants exercise restrictive policies even after an accidental grant.
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON hotel_catalog.organization_setup_track_intents,
        finance.billing_entitlements, booking.booking_settings, marketplace.marketplace_hotel_profiles TO ${role}`);
      for (let index = 0; index < 2; index++) {
        await admin.query(
          `INSERT INTO identity.organizations (id, kind, name, slug)
          VALUES ($1, 'hotel_group', 'Creation products fixture', $1::uuid::text)`,
          [organizations[index]],
        );
        await admin.query(
          `INSERT INTO hotel_catalog.properties (id, public_id, display_name, creation_organization_id)
          VALUES ($1, $1::uuid::text, 'Products fixture', $2)`,
          [properties[index], organizations[index]],
        );
        await admin.query(
          `INSERT INTO identity.organization_resource_links
          (organization_id, product, resource_type, resource_id, relationship, status)
          VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
          [organizations[index], properties[index]],
        );
        await admin.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents
          (organization_id, selected_tracks) VALUES ($1, ARRAY['hotel_operations', 'creator_marketplace'])`,
          [organizations[index]],
        );
        await admin.query(
          `INSERT INTO finance.billing_entitlements (id, organization_id, product, entitlement_key)
          VALUES ($1, $2, 'pms', 'property-management')`,
          [billing[index], organizations[index]],
        );
        await admin.query(`INSERT INTO booking.booking_settings (property_id) VALUES ($1)`, [
          properties[index],
        ]);
        await admin.query(
          `INSERT INTO marketplace.marketplace_hotel_profiles
          (property_id, organization_id, source_hotel_profile_id) VALUES ($1, $2, $1::uuid::text)`,
          [properties[index], organizations[index]],
        );
      }
      await admin.query(
        `INSERT INTO platform.hotel_setup_creation_scopes
        (database_login, organization_id) VALUES ($1, $2)`,
        [role, organizations[0]],
      );
      const connection = new URL(url);
      connection.username = role;
      connection.password = password;
      native = new pg.Pool({ connectionString: connection.toString(), max: 1 });
      for (const [relation, key, ids, lockable] of [
        ["hotel_catalog.organization_setup_track_intents", "organization_id", organizations, true],
        ["finance.billing_entitlements", "id", billing, true],
        ["booking.booking_settings", "property_id", properties, false],
        ["marketplace.marketplace_hotel_profiles", "property_id", properties, false],
      ] as const) {
        expect(
          (
            await native.query(
              `SELECT ${key} FROM ${relation} WHERE ${key}=$1${lockable ? " FOR SHARE" : ""}`,
              [ids[0]],
            )
          ).rows,
        ).toEqual([{ [key]: ids[0] }]);
        expect(
          (await native.query(`SELECT ${key} FROM ${relation} WHERE ${key}=$1`, [ids[1]])).rows,
        ).toEqual([]);
        const update = native.query(`UPDATE ${relation} SET ${key}=${key} WHERE ${key}=$1`, [
          ids[0],
        ]);
        if (lockable) await expect(update).rejects.toMatchObject({ code: "42501" });
        else expect((await update).rowCount).toBe(0);
        expect(
          (await native.query(`DELETE FROM ${relation} WHERE ${key}=$1`, [ids[0]])).rowCount,
        ).toBe(0);
      }
      await expect(
        native.query(
          `INSERT INTO finance.billing_entitlements
        (organization_id, product, entitlement_key) VALUES ($1, 'pms', 'property-management')`,
          [organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents
        (organization_id, selected_tracks) VALUES ($1, ARRAY['creator_marketplace'])`,
          [organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          `INSERT INTO booking.booking_settings
          (property_id,default_currency,supported_currencies,default_language,supported_languages)
          VALUES ($1,'LKR',ARRAY['USD'],'si',ARRAY['en'])`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          `INSERT INTO marketplace.marketplace_hotel_profiles
        (property_id, organization_id, source_hotel_profile_id, marketplace_profile_status)
        VALUES ($1, $2, $1::uuid::text, 'verified')`,
          [properties[0], organizations[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        `INSERT INTO identity.product_entitlements
        (organization_id, product, entitlement_key) VALUES
        ($1,'booking','booking-engine'), ($1,'pms','property-management'),
        ($1,'marketplace','marketplace-hotel-profile')`,
        [organizations[0]],
      );
      const createLinkedProperty = async (product: string, resourceType: string) => {
        const id = randomUUID();
        newProperties.push(id);
        await native!.query("BEGIN");
        try {
          await native!.query(
            `INSERT INTO hotel_catalog.properties
            (id, public_id, display_name, creation_organization_id)
            VALUES ($1, $1::uuid::text, 'New products fixture', $2)`,
            [id, organizations[0]],
          );
          await native!.query(
            `INSERT INTO identity.organization_resource_links
            (organization_id, product, resource_type, resource_id, relationship, status)
            VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
            [organizations[0], id],
          );
          await native!.query(
            `INSERT INTO identity.organization_resource_links
            (organization_id, product, resource_type, resource_id, relationship, status)
            VALUES ($1, $2, $3, $4, 'owner', 'active')`,
            [organizations[0], product, resourceType, id],
          );
          if (product === "booking") {
            await native!.query(`INSERT INTO booking.booking_settings (property_id) VALUES ($1)`, [
              id,
            ]);
          } else if (product === "marketplace") {
            await native!.query(
              `INSERT INTO marketplace.marketplace_hotel_profiles
              (property_id, organization_id, source_hotel_profile_id)
              VALUES ($1, $2, $1::uuid::text)`,
              [id, organizations[0]],
            );
          }
          await native!.query("COMMIT");
          return id;
        } catch (error) {
          await native!.query("ROLLBACK");
          throw error;
        }
      };
      for (const [product, resourceType] of [
        ["booking", "booking_hotel"],
        ["pms", "pms_property"],
        ["marketplace", "hotel_profile"],
      ]) {
        const id = await createLinkedProperty(product!, resourceType!);
        expect(
          (
            await native.query(
              `SELECT product FROM identity.organization_resource_links
          WHERE resource_id=$1 ORDER BY product`,
              [id],
            )
          ).rows.map((row) => row.product),
        ).toEqual(["hotel_catalog", product].sort());
        // Committed properties cannot acquire additional product links in a later transaction.
        await expect(
          native.query(
            `INSERT INTO identity.organization_resource_links
          (organization_id, product, resource_type, resource_id, relationship, status)
          VALUES ($1, $2, $3, $4, 'owner', 'active')`,
            [organizations[0], product, resourceType, id],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await admin.query(
        `INSERT INTO identity.product_entitlements
        (organization_id, product, entitlement_key, status) VALUES ($1,'pms','account_access','suspended')`,
        [organizations[0]],
      );
      await expect(createLinkedProperty("booking", "booking_hotel")).rejects.toMatchObject({
        code: "42501",
      });
      expect(
        (
          await admin.query(`SELECT id FROM hotel_catalog.properties WHERE id=$1`, [
            newProperties.at(-1),
          ])
        ).rows,
      ).toEqual([]);
      await admin.query(
        `DELETE FROM identity.product_entitlements
        WHERE organization_id=$1 AND entitlement_key='account_access'`,
        [organizations[0]],
      );
      await admin.query(
        `UPDATE finance.billing_entitlements SET billing_status='past_due' WHERE id=$1`,
        [billing[0]],
      );
      await expect(createLinkedProperty("pms", "pms_property")).rejects.toMatchObject({
        code: "42501",
      });
      await admin.query(
        `UPDATE hotel_catalog.organization_setup_track_intents
        SET selected_tracks=ARRAY['hotel_operations'] WHERE organization_id=$1`,
        [organizations[0]],
      );
      await expect(createLinkedProperty("marketplace", "hotel_profile")).rejects.toMatchObject({
        code: "42501",
      });
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1`,
        [role],
      );
      expect(
        (
          await native.query(
            `SELECT organization_id FROM hotel_catalog.organization_setup_track_intents`,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await native?.end();
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1`,
        [role],
      );
      await admin.query(`DELETE FROM finance.billing_entitlements WHERE id=ANY($1::uuid[])`, [
        billing,
      ]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links WHERE organization_id=ANY($1::uuid[])`,
        [organizations],
      );
      await admin.query(`DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])`, [
        [...properties, ...newProperties],
      ]);
      await admin.query(
        `DELETE FROM identity.product_entitlements WHERE organization_id=ANY($1::uuid[])`,
        [organizations],
      );
      await admin.query(`DELETE FROM identity.organizations WHERE id=ANY($1::uuid[])`, [
        organizations,
      ]);
      if (created) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
