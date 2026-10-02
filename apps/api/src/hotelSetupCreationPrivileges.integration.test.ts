import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertHotelSetupCreationScope } from "./hotelSetupCommandScope.js";
import {
  assertHotelSetupCreationPrivileges,
  HOTEL_SETUP_CREATION_PRIVILEGES,
} from "./hotelSetupCreationPrivileges.js";
import { lockHotelSetupCreationPermissions } from "./hotelSetupMembership.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("native creation privilege contract", () => {
  it("creates and replays all selected products with exact grants and rejects extra privileges", async () => {
    if (!url || !new URL(url).pathname.startsWith("/vay1092_vay965_creation_test"))
      throw new Error("dedicated creation test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const role = `vayada_next_hotel_setup_org_${randomUUID().replaceAll("-", "")}`;
    const organizationId = randomUUID();
    const actorUserId = randomUUID();
    const password = randomUUID();
    const database = new URL(url).pathname.slice(1).replaceAll('"', '""');
    const login = new URL(url);
    login.username = role;
    login.password = password;
    const native = new pg.Pool({ connectionString: login.toString(), max: 1 });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: login.toString(),
      pool: native,
    });
    let createdRole = false;
    let restoreTemp = false;
    try {
      restoreTemp = (
        await admin.query(
          `SELECT has_database_privilege('public',current_database(),'TEMP') AS allowed`,
        )
      ).rows[0]!.allowed;
      await admin.query(`REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC`);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      createdRole = true;
      await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
      await admin.query(
        `GRANT USAGE ON SCHEMA hotel_catalog, identity, platform, booking, marketplace, finance TO ${role}`,
      );
      await admin.query(
        `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      for (const [relation, privileges] of Object.entries(HOTEL_SETUP_CREATION_PRIVILEGES)) {
        for (const [privilege, columns] of Object.entries(privileges)) {
          await admin.query(`GRANT ${privilege} (${columns.join(",")}) ON ${relation} TO ${role}`);
        }
      }
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
        VALUES ($1,'hotel_group','Exact creation fixture',$1::uuid::text)`,
        [organizationId],
      );
      await admin.query(
        `INSERT INTO identity.users (id,email,name)
        VALUES ($1,$1::uuid::text || '@example.test','Creation owner')`,
        [actorUserId],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
        (organization_id,user_id,role_key,pms_access_enabled,booking_access_enabled,access_origin)
        VALUES ($1,$2,'hotel_owner',false,false,'agency')`,
        [organizationId, actorUserId],
      );
      await admin.query(
        `INSERT INTO platform.hotel_setup_creation_scopes (database_login,organization_id)
        VALUES ($1,$2)`,
        [role, organizationId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.organization_setup_track_intents (organization_id,selected_tracks)
        VALUES ($1,ARRAY['hotel_operations','creator_marketplace'])`,
        [organizationId],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements (organization_id,product,entitlement_key)
        VALUES ($1,'booking','booking-engine'),($1,'pms','property-management'),
          ($1,'marketplace','marketplace-hotel-profile')`,
        [organizationId],
      );
      const client = await native.connect();
      try {
        await client.query("BEGIN");
        await assertHotelSetupCreationScope(client, organizationId);
        await assertHotelSetupCreationPrivileges(client);
        expect(
          await lockHotelSetupCreationPermissions(client, { organizationId, actorUserId }),
        ).toContain("hotel_catalog.setup.manage");
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      const command = {
        organizationId,
        idempotencyKey: "exact-native-create",
        correlationId: "exact-native-create",
        profile: {
          displayName: "Exact hotel",
          propertyType: "hotel" as const,
          location: {
            countryCode: "DE",
            city: "Berlin",
            streetAddress: "Test 1",
            postalCode: "10115",
            timezone: "Europe/Berlin",
            latitude: null,
            longitude: null,
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden" as const,
          },
          contacts: [
            {
              channelType: "email" as const,
              value: "owner@example.test",
              purpose: "guest" as const,
              isPublic: false,
            },
          ],
        },
        audit: {
          actorUserId,
          requestId: "exact-native-create",
          receivedAt: new Date().toISOString(),
        },
      };
      const created = await repository.createPropertyProfile(command);
      await expect(repository.createPropertyProfile(command)).resolves.toMatchObject({
        propertyId: created.propertyId,
      });
      expect(
        (
          await admin.query(
            `SELECT product FROM identity.organization_resource_links
        WHERE organization_id=$1 ORDER BY product`,
            [organizationId],
          )
        ).rows.map((row) => row.product),
      ).toEqual(["booking", "hotel_catalog", "marketplace", "pms"]);
      expect(
        (
          await admin.query(
            `SELECT property_id FROM booking.booking_settings WHERE property_id=$1`,
            [created.propertyId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await admin.query(
            `SELECT property_id FROM marketplace.marketplace_hotel_profiles WHERE property_id=$1`,
            [created.propertyId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await admin.query(
            `SELECT id FROM platform.product_audit_events WHERE organization_id=$1`,
            [organizationId],
          )
        ).rowCount,
      ).toBe(1);
      await admin.query(
        `GRANT SELECT (private_payload) ON platform.product_audit_events TO ${role}`,
      );
      await expect(assertHotelSetupCreationPrivileges(native)).rejects.toThrow(
        "column privileges mismatch",
      );
      await admin.query(
        `REVOKE SELECT (private_payload) ON platform.product_audit_events FROM ${role}`,
      );
      await admin.query(`GRANT TEMP ON DATABASE "${database}" TO ${role}`);
      await expect(assertHotelSetupCreationPrivileges(native)).rejects.toThrow(
        "privilege posture mismatch",
      );
    } finally {
      await native.end();
      await admin.query(
        `DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1`,
        [role],
      );
      await admin.query("BEGIN");
      try {
        await admin.query(
          `ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only`,
        );
        await admin.query(`DELETE FROM platform.product_audit_events WHERE organization_id=$1`, [
          organizationId,
        ]);
        await admin.query(
          `ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await admin.query(`DELETE FROM platform.idempotency_keys WHERE organization_id=$1`, [
        organizationId,
      ]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links WHERE organization_id=$1`,
        [organizationId],
      );
      await admin.query(`DELETE FROM hotel_catalog.properties WHERE creation_organization_id=$1`, [
        organizationId,
      ]);
      await admin.query(`DELETE FROM identity.product_entitlements WHERE organization_id=$1`, [
        organizationId,
      ]);
      await admin.query(`DELETE FROM identity.organization_memberships WHERE organization_id=$1`, [
        organizationId,
      ]);
      await admin.query(`DELETE FROM identity.organizations WHERE id=$1`, [organizationId]);
      await admin.query(`DELETE FROM identity.users WHERE id=$1`, [actorUserId]);
      if (createdRole) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      if (restoreTemp) await admin.query(`GRANT TEMP ON DATABASE "${database}" TO PUBLIC`);
      await admin.end();
    }
  });
});
