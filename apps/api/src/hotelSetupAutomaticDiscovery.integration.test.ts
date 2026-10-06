import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  advanceHotelSetupAutomaticCursor,
  discoverHotelSetupAutomaticCandidates,
  inspectHotelSetupAutomaticIdentity,
} from "./hotelSetupAutomaticDiscovery.js";
import { hotelSetupOrganizationRolePrefix } from "./hotelSetupOrganizationRoleStaging.js";

const connectionString = process.env.HOTEL_SETUP_AUTOMATIC_DISCOVERY_TEST_DATABASE_URL;
describe.runIf(connectionString)("owned PostgreSQL automatic discovery", () => {
  it("seeks past earlier candidates, wraps per mode, excludes stale bindings and inspects durable identities", async () => {
    const url = new URL(connectionString!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_") ||
      url.searchParams.get("sslmode") !== "verify-full"
    )
      throw new Error("Owned TLS fixture required");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    await admin.query("BEGIN");
    try {
      const exists = await admin.query(
        "SELECT to_regclass('platform.hotel_setup_reconciliation_cursors') AS name",
      );
      if (!exists.rows[0]?.name)
        await admin.query(
          await readFile(
            new URL(
              "../../../packages/backend-migration/migrations/0464_hotel_setup_reconciliation_cursor.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      const acl = await admin.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
        WHERE c.oid='platform.hotel_setup_reconciliation_cursors'::regclass AND acl.grantee<>c.relowner`);
      expect(acl.rows[0]?.count).toBe(0);
      // Leave all preexisting rows untouched after ROLLBACK. The local fixture owns these temporary facts.
      await admin.query("DELETE FROM platform.hotel_setup_reconciliation_cursors");
      await admin.query(
        "INSERT INTO platform.hotel_setup_reconciliation_cursors(mode) VALUES ('organization'),('property')",
      );
      // Serial owned fixture only: isolate discovery inside this rolled-back transaction.
      await admin.query(
        "UPDATE identity.organization_memberships SET status='inactive' WHERE status='active'",
      );
      const organizations = [randomUUID(), randomUUID(), randomUUID()].sort();
      const actors = [randomUUID(), randomUUID(), randomUUID()].sort();
      const propertyId = randomUUID();
      for (const [index, org] of organizations.entries()) {
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','discovery fixture',($1::uuid)::text)",
          [org],
        );
        const users = index === 0 ? actors : [randomUUID()];
        for (const actor of users) {
          await admin.query(
            "INSERT INTO identity.users(id,email) VALUES($1::uuid,($1::uuid)::text || '@fixture.invalid')",
            [actor],
          );
          await admin.query(
            `INSERT INTO identity.organization_memberships
            (organization_id,user_id,role_key,property_access_mode,access_origin,pms_access_enabled,booking_access_enabled)
            VALUES($1,$2,'owner','all','agency',true,true)`,
            [org, actor],
          );
        }
      }
      // Seek directly to synthetic rows; no older fixture scope is modified or provisioned.
      await admin.query(
        `UPDATE platform.hotel_setup_reconciliation_cursors
        SET scope_id=$1::uuid,organization_id=$1::uuid,actor_user_id='00000000-0000-0000-0000-000000000000'
        WHERE mode='organization'`,
        [organizations[0]],
      );
      const first = await discoverHotelSetupAutomaticCandidates(admin, "organization");
      expect(first.map((c) => c.actorUserId)).toEqual(actors.slice(0, 2));
      await advanceHotelSetupAutomaticCursor(admin, "organization", first[1]);
      const second = await discoverHotelSetupAutomaticCandidates(admin, "organization");
      expect(second[0]?.actorUserId).toBe(actors[2]);
      expect(second[1]?.organizationId).toBe(organizations[1]);
      await advanceHotelSetupAutomaticCursor(admin, "organization", second[1]);
      expect(
        (await discoverHotelSetupAutomaticCandidates(admin, "organization"))[0]?.organizationId,
      ).toBe(organizations[2]);
      await admin.query(`UPDATE platform.hotel_setup_reconciliation_cursors
        SET scope_id='ffffffff-ffff-ffff-ffff-ffffffffffff',organization_id=scope_id,actor_user_id=scope_id WHERE mode='organization'`);
      expect(await discoverHotelSetupAutomaticCandidates(admin, "organization")).toEqual([]);
      await advanceHotelSetupAutomaticCursor(admin, "organization");
      const state = await admin.query(
        "SELECT scope_id,organization_id,actor_user_id FROM platform.hotel_setup_reconciliation_cursors WHERE mode='organization'",
      );
      expect(Object.values(state.rows[0]!)).toEqual([null, null, null]);

      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'discovery fixture')",
        [propertyId],
      );
      const owner = organizations[0]!;
      await admin.query(
        `INSERT INTO identity.organization_resource_links
        (organization_id,product,resource_type,resource_id,relationship) VALUES
        ($1,'hotel_catalog','property',$2,'owner'),($1,'pms','pms_property',$2,'owner')`,
        [owner, propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.organization_setup_track_intents
        (organization_id,selected_tracks) VALUES($1,ARRAY['creator_marketplace'])`,
        [owner],
      );
      expect(await discoverHotelSetupAutomaticCandidates(admin, "property")).toEqual([]);
      await admin.query(
        "UPDATE hotel_catalog.organization_setup_track_intents SET selected_tracks=ARRAY['hotel_operations'] WHERE organization_id=$1",
        [owner],
      );
      const properties = await discoverHotelSetupAutomaticCandidates(admin, "property");
      expect(properties.map((c) => c.scopeId)).toEqual([propertyId, propertyId]);
      await advanceHotelSetupAutomaticCursor(admin, "property", properties[1]);
      expect((await discoverHotelSetupAutomaticCandidates(admin, "property"))[0]?.actorUserId).toBe(
        actors[2],
      );
      await admin.query(
        "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$1 AND product='pms'",
        [owner],
      );
      expect(await discoverHotelSetupAutomaticCandidates(admin, "property")).toEqual([]);
      // An earlier staged NOLOGIN identity has no assignment and must never be adopted.
      const candidate = { scopeId: owner, organizationId: owner, actorUserId: actors[0]! };
      expect(await inspectHotelSetupAutomaticIdentity(admin, candidate)).toBe("fresh");
      const login = `${hotelSetupOrganizationRolePrefix(owner)}abcdefabcdef`;
      await admin.query(`CREATE ROLE ${admin.escapeIdentifier(login)} NOLOGIN`);
      expect(await inspectHotelSetupAutomaticIdentity(admin, candidate)).toBe(
        "inspection_required",
      );
      await admin.query(
        "INSERT INTO platform.hotel_setup_creation_scopes(database_login,organization_id) VALUES($1,$2)",
        [login, owner],
      );
      expect(await inspectHotelSetupAutomaticIdentity(admin, candidate)).toBe(
        "inspection_required",
      );
      await admin.query(`ALTER ROLE ${admin.escapeIdentifier(login)} LOGIN`);
      await admin.query(
        `UPDATE platform.hotel_setup_creation_scopes SET credential_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1),
        credential_secret_version=$3,credential_ready_at=clock_timestamp() WHERE organization_id=$2`,
        [login, owner, randomUUID()],
      );
      expect(await inspectHotelSetupAutomaticIdentity(admin, candidate)).toBe("existing_ready");
      await admin.query(
        "UPDATE platform.hotel_setup_creation_scopes SET credential_role_oid=(credential_role_oid::bigint+1)::oid WHERE organization_id=$1",
        [owner],
      );
      expect(await inspectHotelSetupAutomaticIdentity(admin, candidate)).toBe(
        "inspection_required",
      );
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  });
});
