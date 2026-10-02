import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { lockHotelSetupCreationPermissions } from "./hotelSetupMembership.js";
import { assertHotelSetupCreationScope } from "./hotelSetupCommandScope.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("native creation identity locks", () => {
  it("locks its own current identity rows while hiding foreign identities and denying edits", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const role = `vayada_next_hotel_setup_org_${suffix}`;
    const password = randomUUID();
    const organizations = [randomUUID(), randomUUID()];
    const users = [randomUUID(), randomUUID()];
    const memberships = [randomUUID(), randomUUID()];
    const definitions = [randomUUID(), randomUUID()];
    let native: pg.Pool | undefined;
    let roleCreated = false;
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      roleCreated = true;
      const database = new URL(url).pathname.slice(1).replaceAll('"', '""');
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
      await admin.query(`GRANT USAGE ON SCHEMA identity, hotel_catalog, platform TO ${role}`);
      await admin.query(
        `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      // Excessive fixture grants prove the row boundary, not a production inventory.
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.organizations,
        identity.users, identity.organization_memberships, identity.organization_roles,
        identity.role_permission_grants TO ${role}`);
      for (let index = 0; index < 2; index++) {
        await admin.query(
          `INSERT INTO identity.organizations (id, kind, name, slug)
          VALUES ($1, 'hotel_group', 'Creation identity fixture', $1::uuid::text)`,
          [organizations[index]],
        );
        await admin.query(
          `INSERT INTO identity.users (id, email)
          VALUES ($1, $1::uuid::text || '@example.test')`,
          [users[index]],
        );
        await admin.query(
          `INSERT INTO identity.organization_memberships
          (id, organization_id, user_id, role_key, access_origin, property_access_mode, pms_access_enabled, booking_access_enabled) VALUES ($1, $2, $3, $4, 'agency', 'all', false, false)`,
          [
            memberships[index],
            organizations[index],
            users[index],
            index === 0 ? "hotel_owner" : "hotel_manager",
          ],
        );
        await admin.query(
          `INSERT INTO identity.organization_roles
          (id, organization_id, name, security_class, base_role_key, default_permissions)
          VALUES ($1, $2, 'Creation test role', 'staff', 'hotel_manager', '[]')`,
          [definitions[index], organizations[index]],
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
      await native.query("BEGIN");
      await assertHotelSetupCreationScope(native, organizations[0]!);
      expect(
        await lockHotelSetupCreationPermissions(native, {
          organizationId: organizations[0]!,
          actorUserId: users[0]!,
        }),
      ).toContain("hotel_catalog.setup.manage");
      expect(
        await lockHotelSetupCreationPermissions(native, {
          organizationId: organizations[0]!,
          actorUserId: users[1]!,
        }),
      ).toBeNull();
      const currentPermissions = await lockHotelSetupCreationPermissions(native, {
        organizationId: organizations[0]!,
        actorUserId: users[0]!,
      });
      expect(
        currentPermissions?.some(
          (permission) => permission.startsWith("pms.") || permission.startsWith("booking."),
        ),
      ).toBe(false);
      for (const [relation, ids] of [
        ["organizations", organizations],
        ["users", users],
        ["organization_memberships", memberships],
        ["organization_roles", definitions],
      ] as const) {
        expect(
          (
            await native.query(`SELECT id FROM identity.${relation} WHERE id=$1 FOR SHARE`, [
              ids[0],
            ])
          ).rows,
        ).toEqual([{ id: ids[0] }]);
        expect(
          (
            await native.query(`SELECT id FROM identity.${relation} WHERE id=$1 FOR SHARE`, [
              ids[1],
            ])
          ).rows,
        ).toEqual([]);
      }
      expect(
        (
          await native.query(`SELECT permission_key FROM identity.role_permission_grants
        WHERE organization_kind='hotel_group' AND role_key='hotel_owner'
          AND permission_key='hotel_catalog.setup.manage' FOR SHARE`)
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await native.query(`SELECT permission_key FROM identity.role_permission_grants
        WHERE organization_kind='hotel_group' AND role_key='hotel_manager'`)
        ).rows,
      ).toEqual([]);
      await native.query("COMMIT");
      for (const [relation, id] of [
        ["organizations", organizations[0]],
        ["users", users[0]],
        ["organization_memberships", memberships[0]],
        ["organization_roles", definitions[0]],
      ]) {
        await expect(
          native.query(`UPDATE identity.${relation} SET id=id WHERE id=$1`, [id]),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (await native.query(`DELETE FROM identity.${relation} WHERE id=$1`, [id])).rowCount,
        ).toBe(0);
      }
      await expect(
        native.query(`UPDATE identity.role_permission_grants SET id=id
        WHERE organization_kind='hotel_group' AND role_key='hotel_owner'
          AND permission_key='hotel_catalog.setup.manage'`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(`INSERT INTO identity.users (email) VALUES ('new@example.test')`),
      ).rejects.toMatchObject({ code: "42501" });
      const permissions = () =>
        lockHotelSetupCreationPermissions(native!, {
          organizationId: organizations[0]!,
          actorUserId: users[0]!,
        });
      await admin.query(
        `UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1`,
        [memberships[0]],
      );
      expect(await permissions()).toBeNull();
      await admin.query(
        `UPDATE identity.organization_memberships SET status='active', role_definition_id=$2 WHERE id=$1`,
        [memberships[0], definitions[0]],
      );
      expect(await permissions()).toBeNull();
      await admin.query(
        `UPDATE identity.organization_memberships SET role_definition_id=NULL,
        role_key='front_desk', property_access_mode='assigned' WHERE id=$1`,
        [memberships[0]],
      );
      expect(await permissions()).toBeNull();
      await admin.query(
        `UPDATE identity.organization_memberships SET role_key='hotel_owner',
        property_access_mode='all' WHERE id=$1`,
        [memberships[0]],
      );
      await admin.query(`UPDATE identity.users SET status='suspended' WHERE id=$1`, [users[0]]);
      expect(await permissions()).toBeNull();
      await admin.query(`UPDATE identity.organizations SET status='suspended' WHERE id=$1`, [
        organizations[0],
      ]);
      await expect(assertHotelSetupCreationScope(native, organizations[0]!)).rejects.toThrow(
        "Hotel setup creation scope preflight failed",
      );
      expect(
        (await native.query(`SELECT id FROM identity.users WHERE id=$1`, [users[0]])).rows,
      ).toEqual([]);
    } finally {
      if (native) {
        await native.query("ROLLBACK").catch(() => undefined);
        await native.end();
      }
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1`,
        [role],
      );
      await admin.query(`DELETE FROM identity.organization_memberships WHERE id=ANY($1::uuid[])`, [
        memberships,
      ]);
      await admin.query(`DELETE FROM identity.organization_roles WHERE id=ANY($1::uuid[])`, [
        definitions,
      ]);
      await admin.query(`DELETE FROM identity.users WHERE id=ANY($1::uuid[])`, [users]);
      await admin.query(`DELETE FROM identity.organizations WHERE id=ANY($1::uuid[])`, [
        organizations,
      ]);
      if (roleCreated) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
