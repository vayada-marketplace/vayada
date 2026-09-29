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
    const logins: pg.Pool[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const role = roles[index]!;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[index]}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${role}`);
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON hotel_catalog.properties TO ${role}`,
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

      for (let index = 0; index < 2; index++) {
        const row = await logins[index]!.query<{ id: string }>(
          `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Scoped hotel', $3) RETURNING id`,
          [properties[index], `setup-property-${index}-${suffix}`, organizations[index]],
        );
        expect(row.rows[0]?.id).toBe(properties[index]);
      }

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
    } finally {
      await Promise.all(logins.map((login) => login.end()));
      await admin.query(
        "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login = ANY($1::name[])",
        [roles],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
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
