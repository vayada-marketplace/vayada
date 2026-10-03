import { spawnSync } from "node:child_process";
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
      hotelSetupNativeCreation: true,
    });
    let createdRole = false;
    const databaseAcls = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type)
        FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    try {
      for (const acl of databaseAcls)
        await admin.query(`REVOKE ALL ON DATABASE ${quote(acl.name)} FROM PUBLIC`);
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
      const credentialUrl = new URL(login);
      credentialUrl.searchParams.set("sslmode", "verify-full");
      const endpoint = new URL(login);
      endpoint.username = endpoint.password = endpoint.search = "";
      const runPreflight = (overrides: NodeJS.ProcessEnv = {}) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            new URL("./cli/hotelSetupCreationPreflight.ts", import.meta.url).pathname,
          ],
          {
            encoding: "utf8",
            timeout: 30_000,
            env: {
              ...process.env,
              HOTEL_SETUP_COMMAND_DATABASE_URL: credentialUrl.toString(),
              HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: endpoint.toString(),
              HOTEL_SETUP_COMMAND_DATABASE_LOGIN: role,
              HOTEL_SETUP_COMMAND_ORGANIZATION_ID: organizationId,
              HOTEL_SETUP_COMMAND_ACTOR_USER_ID: actorUserId,
              PGHOST: "untrusted.invalid",
              PGPORT: "1",
              PGOPTIONS: "-c role=postgres",
              ...overrides,
            },
          },
        );
      const before = (
        await admin.query("SELECT count(*)::text AS count FROM platform.product_audit_events")
      ).rows;
      expect(runPreflight()).toMatchObject({
        status: 0,
        stderr: "",
        stdout: '{"status":"PASS","scope":"hotel_setup_creation"}\n',
      });
      expect(runPreflight({ HOTEL_SETUP_COMMAND_ACTOR_USER_ID: randomUUID() })).toMatchObject({
        status: 1,
        stdout: "",
      });
      expect(runPreflight({ NODE_EXTRA_CA_CERTS: "" })).toMatchObject({ status: 1, stdout: "" });
      expect(
        (await admin.query("SELECT count(*)::text AS count FROM platform.product_audit_events"))
          .rows,
      ).toEqual(before);
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
      await admin.query(
        `UPDATE identity.organization_memberships SET status='inactive'
        WHERE organization_id=$1 AND user_id=$2`,
        [organizationId, actorUserId],
      );
      await expect(repository.createPropertyProfile(command)).rejects.toThrow("not authorized");
      await admin.query(
        `UPDATE identity.organization_memberships SET status='active'
        WHERE organization_id=$1 AND user_id=$2`,
        [organizationId, actorUserId],
      );
      await expect(
        repository.createPropertyProfile({ ...command, targetAccountUserId: actorUserId }),
      ).rejects.toThrow("not authorized");
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
      const publicationGrants = await admin.query(`DELETE FROM identity.role_permission_grants
        WHERE organization_kind='hotel_group' AND role_key='hotel_owner'
          AND permission_key IN ('marketplace.profile.manage','booking.settings.manage') RETURNING *`);
      try {
        await expect(
          repository.createPropertyProfile({
            ...command,
            idempotencyKey: "publication-denied",
            profile: {
              ...command.profile,
              location: { ...command.profile.location, localityPublic: true },
            },
          }),
        ).rejects.toThrow("not authorized");
      } finally {
        for (const grant of publicationGrants.rows) {
          await admin.query(
            `INSERT INTO identity.role_permission_grants
            (id,organization_kind,role_key,permission_key,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [
              grant.id,
              grant.organization_kind,
              grant.role_key,
              grant.permission_key,
              grant.created_at,
            ],
          );
        }
      }
      const initialLaunchSettings = {
        defaultCurrency: "LKR",
        supportedCurrencies: ["USD"],
        defaultLanguage: "si",
        supportedLanguages: ["en"],
        instagram: "https://instagram.com/native_hotel",
        facebook: "",
        tiktok: "https://tiktok.com/@native_hotel",
        youtube: "https://youtube.com/@native_hotel",
      };
      const atomic = {
        ...command,
        idempotencyKey: "atomic-initial",
        profile: {
          ...command.profile,
          initialLaunchSettings,
        },
      };
      const saved = await repository.createPropertyProfile(atomic);
      expect(saved.profile).not.toHaveProperty("initialLaunchSettings");
      expect(saved.profile.contacts).toEqual(command.profile.contacts);
      await expect(repository.createPropertyProfile(atomic)).resolves.toEqual(saved);
      expect(
        (
          await admin.query(
            `SELECT default_currency::text AS "defaultCurrency",
        supported_currencies AS "supportedCurrencies", default_language AS "defaultLanguage",
        supported_languages AS "supportedLanguages" FROM booking.booking_settings WHERE property_id=$1`,
            [saved.propertyId],
          )
        ).rows,
      ).toEqual([
        {
          defaultCurrency: "LKR",
          supportedCurrencies: ["USD"],
          defaultLanguage: "si",
          supportedLanguages: ["en"],
        },
      ]);
      expect(
        (
          await admin.query(
            `SELECT channel_type,value,is_public,source_system
        FROM hotel_catalog.property_contact_channels WHERE property_id=$1 AND source_system='booking'
        ORDER BY channel_type`,
            [saved.propertyId],
          )
        ).rows,
      ).toEqual([
        {
          channel_type: "instagram",
          value: initialLaunchSettings.instagram,
          is_public: true,
          source_system: "booking",
        },
        {
          channel_type: "tiktok",
          value: initialLaunchSettings.tiktok,
          is_public: true,
          source_system: "booking",
        },
        {
          channel_type: "youtube",
          value: initialLaunchSettings.youtube,
          is_public: true,
          source_system: "booking",
        },
      ]);
      for (const profile of [
        command.profile,
        {
          ...atomic.profile,
          initialLaunchSettings: { ...initialLaunchSettings, defaultCurrency: "USD" },
        },
        { ...atomic.profile, initialLaunchSettings: { ...initialLaunchSettings, instagram: "" } },
      ]) {
        await expect(
          repository.createPropertyProfile({ ...atomic, profile }),
        ).rejects.toMatchObject({
          code: "idempotency_key_conflict",
          propertyId: saved.propertyId,
        });
      }
      const countProperties = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM hotel_catalog.properties WHERE creation_organization_id=$1",
            [organizationId],
          )
        ).rows[0].count;
      const beforeAtomicDenials = await countProperties();
      await admin.query(
        `UPDATE hotel_catalog.organization_setup_track_intents
        SET selected_tracks=ARRAY['creator_marketplace'] WHERE organization_id=$1`,
        [organizationId],
      );
      await expect(
        repository.createPropertyProfile({ ...atomic, idempotencyKey: "creator-only-denied" }),
      ).rejects.toThrow("not authorized");
      await admin.query(
        `UPDATE hotel_catalog.organization_setup_track_intents
        SET selected_tracks=ARRAY['hotel_operations','creator_marketplace'] WHERE organization_id=$1`,
        [organizationId],
      );
      await admin.query(
        `UPDATE identity.product_entitlements SET status='suspended'
        WHERE organization_id=$1 AND product='booking'`,
        [organizationId],
      );
      await expect(
        repository.createPropertyProfile({ ...atomic, idempotencyKey: "inactive-booking-denied" }),
      ).rejects.toThrow("not authorized");
      await admin.query(
        `UPDATE identity.product_entitlements SET status='active'
        WHERE organization_id=$1 AND product='booking'`,
        [organizationId],
      );
      await expect(
        repository.createPropertyProfile({
          ...atomic,
          idempotencyKey: "private-social-denied",
          profile: {
            ...atomic.profile,
            contacts: [
              ...command.profile.contacts,
              {
                channelType: "instagram",
                value: initialLaunchSettings.instagram,
                purpose: "operations",
                isPublic: false,
              },
            ],
          },
        }),
      ).rejects.toThrow("private hotel information");
      expect(await countProperties()).toBe(beforeAtomicDenials);
      expect(
        (
          await admin.query(
            `SELECT id FROM platform.idempotency_keys WHERE organization_id=$1
        AND status<>'completed'`,
            [organizationId],
          )
        ).rows,
      ).toEqual([]);
      for (const propertyId of [saved.propertyId, randomUUID()]) {
        await expect(
          native.query(
            `INSERT INTO booking.booking_settings
          (property_id,default_currency,supported_currencies,default_language,supported_languages)
          VALUES ($1,'LKR',ARRAY['USD'],'si',ARRAY['en'])`,
            [propertyId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        native.query(
          `UPDATE booking.booking_settings SET default_currency='USD'
        WHERE property_id=$1`,
          [saved.propertyId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const socialGrants = await admin.query(`DELETE FROM identity.role_permission_grants
        WHERE organization_kind='hotel_group' AND role_key='hotel_owner'
          AND permission_key IN ('marketplace.profile.manage','booking.settings.manage') RETURNING *`);
      try {
        await expect(
          repository.createPropertyProfile({
            ...atomic,
            idempotencyKey: "initial-publication-denied",
          }),
        ).rejects.toThrow("not authorized");
      } finally {
        for (const grant of socialGrants.rows)
          await admin.query(
            `INSERT INTO identity.role_permission_grants
          (id,organization_kind,role_key,permission_key,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [
              grant.id,
              grant.organization_kind,
              grant.role_key,
              grant.permission_key,
              grant.created_at,
            ],
          );
      }
      await admin.query(
        `GRANT SELECT (private_payload) ON platform.product_audit_events TO ${role}`,
      );
      await expect(assertHotelSetupCreationPrivileges(native)).rejects.toThrow(
        "column privileges mismatch",
      );
      await expect(repository.createPropertyProfile(command)).rejects.toThrow(
        "column privileges mismatch",
      );
      await admin.query(
        `REVOKE SELECT (private_payload) ON platform.product_audit_events FROM ${role}`,
      );
      await admin.query(`GRANT TEMP ON DATABASE "${database}" TO ${role}`);
      await expect(assertHotelSetupCreationPrivileges(native)).rejects.toThrow(
        "privilege posture mismatch",
      );
      await expect(repository.createPropertyProfile(command)).rejects.toThrow(
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
      for (const acl of databaseAcls)
        if (acl.privileges.length)
          await admin.query(
            `GRANT ${acl.privileges.join(",")} ON DATABASE ${quote(acl.name)} TO PUBLIC`,
          );
      await admin.end();
    }
  });
});
