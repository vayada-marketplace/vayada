import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { writeHotelSetupLaunchSettings } from "./hotelSetupLaunchSettingsRepository.js";
import {
  assertHotelSetupLaunchSettingsPrivileges,
  HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES,
} from "./hotelSetupLaunchSettingsPrivileges.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native launch settings SQL", () => {
  it("saves only its hotel's settings, denies other rows and revocation, preserves private contacts", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const suffix = randomUUID().replaceAll("-", "");
    const role = `vayada_next_hotel_setup_property_launch_${suffix.slice(0, 20)}`;
    const roleKey = `launch_${suffix}`;
    const ordinaryRole = `vayada_test_launch_reader_${suffix.slice(0, 20)}`;
    const organizationId = randomUUID(),
      userId = randomUUID();
    const properties = [randomUUID(), randomUUID()];
    const admin = new pg.Client({ connectionString: url });
    let native: pg.Pool | undefined;
    let roleCreated = false;
    let ordinary: pg.Pool | undefined;
    let ordinaryCreated = false;
    await admin.connect();
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','SQL fixture',$2)",
        [organizationId, suffix],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        userId,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled,booking_access_enabled) VALUES($1,$2,$3,'agency','all',FALSE,FALSE)",
        [organizationId, userId, roleKey],
      );
      await admin.query(
        "INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,'hotel_catalog.setup.manage')",
        [roleKey],
      );
      for (const property of properties) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'SQL fixture',$2)",
          [property, organizationId],
        );
        await admin.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')",
          [organizationId, property],
        );
        await admin.query(
          "INSERT INTO booking.booking_settings(property_id,guest_count_enabled) VALUES($1,TRUE)",
          [property],
        );
        await admin.query(
          "INSERT INTO hotel_catalog.property_public_profile_read_model(property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status) VALUES($1::uuid,$1::uuid::text,'SQL fixture',$1::uuid::text,'en',ARRAY['en'],'incomplete')",
          [property],
        );
        await admin.query(
          "INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,is_public,source_system) VALUES($1,'email','keep@example.test',TRUE,'booking'),($1,'instagram','https://example.test/private',FALSE,'platform')",
          [property],
        );
      }
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE ${ordinaryRole} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      ordinaryCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog,booking TO ${ordinaryRole}`);
      await admin.query(
        `GRANT SELECT ON booking.booking_settings,hotel_catalog.property_contact_channels,hotel_catalog.property_public_profile_read_model TO ${ordinaryRole}`,
      );
      await admin.query(
        `GRANT UPDATE(guest_count_enabled) ON booking.booking_settings TO ${ordinaryRole}`,
      );
      const ordinaryUrl = new URL(url!);
      ordinaryUrl.username = ordinaryRole;
      ordinaryUrl.password = password;
      ordinary = new pg.Pool({ connectionString: ordinaryUrl.toString(), max: 1 });
      expect(
        (
          await ordinary.query(
            "SELECT property_id FROM booking.booking_settings WHERE property_id=ANY($1::uuid[])",
            [properties],
          )
        ).rowCount,
      ).toBe(2);
      await ordinary.query(
        "SELECT property_id FROM hotel_catalog.property_contact_channels WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      await ordinary.query(
        "SELECT property_id FROM hotel_catalog.property_public_profile_read_model WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      expect(
        (
          await ordinary.query(
            "UPDATE booking.booking_settings SET guest_count_enabled=TRUE WHERE property_id=ANY($1::uuid[])",
            [properties],
          )
        ).rowCount,
      ).toBe(2);
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT vayada_next_hotel_setup_property_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA identity,platform,hotel_catalog,booking TO ${role}`);
      for (const [table, privileges] of Object.entries(HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES)) {
        for (const [privilege, columns] of Object.entries(privileges))
          await admin.query(`GRANT ${privilege}(${columns.join(",")}) ON ${table} TO ${role}`);
      }
      await admin.query(`GRANT DELETE ON hotel_catalog.property_contact_channels TO ${role}`);
      await admin.query(
        "INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class) VALUES($1,$2,$3,'launch_settings')",
        [role, properties[0], organizationId],
      );
      endpoint.username = role;
      endpoint.password = password;
      native = new pg.Pool({ connectionString: endpoint.toString(), max: 1 });
      await assertHotelSetupLaunchSettingsPrivileges(native);
      expect(
        (await native.query("SELECT * FROM booking.pricing_runtime_effective_property_scopes"))
          .rows,
      ).toEqual([]);
      expect(
        (await native.query("SELECT * FROM booking.pricing_runtime_effective_authority_scopes"))
          .rows,
      ).toEqual([]);
      await admin.query(`GRANT UPDATE(guest_count_enabled) ON booking.booking_settings TO ${role}`);
      await expect(assertHotelSetupLaunchSettingsPrivileges(native)).rejects.toThrow(
        /privileges mismatch/,
      );
      await admin.query(
        `REVOKE UPDATE(guest_count_enabled) ON booking.booking_settings FROM ${role}`,
      );
      await admin.query(`GRANT DELETE ON booking.booking_settings TO ${role}`);
      await expect(assertHotelSetupLaunchSettingsPrivileges(native)).rejects.toThrow(
        /unsafe capabilities/,
      );
      await admin.query(`REVOKE DELETE ON booking.booking_settings FROM ${role}`);
      await admin.query(`REVOKE DELETE ON hotel_catalog.property_contact_channels FROM ${role}`);
      await expect(assertHotelSetupLaunchSettingsPrivileges(native)).rejects.toThrow(
        /unsafe capabilities/,
      );
      await admin.query(
        `GRANT DELETE ON hotel_catalog.property_contact_channels TO ${role} WITH GRANT OPTION`,
      );
      await expect(assertHotelSetupLaunchSettingsPrivileges(native)).rejects.toThrow(
        /unsafe capabilities/,
      );
      await admin.query(
        `REVOKE GRANT OPTION FOR DELETE ON hotel_catalog.property_contact_channels FROM ${role}`,
      );
      await assertHotelSetupLaunchSettingsPrivileges(native);
      const context = {
        actor: { internalUserId: userId, providerIdentity: { sessionId: "verified-session" } },
        selectedOrganization: { organizationId },
        audit: { requestId: suffix },
      } as unknown as RequestContext;
      const settings = {
        defaultCurrency: "LKR",
        supportedCurrencies: ["USD"],
        defaultLanguage: "en",
        supportedLanguages: [],
        instagram: "https://example.test/public",
        facebook: "",
        tiktok: "",
        youtube: "",
      };
      expect(
        await writeHotelSetupLaunchSettings(native, context, properties[0]!, settings),
      ).toEqual(settings);
      expect(
        await writeHotelSetupLaunchSettings(native, context, properties[0]!, settings),
      ).toEqual(settings);
      const projected = (
        await admin.query(
          "SELECT public_contacts FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
          [properties[0]],
        )
      ).rows[0].public_contacts;
      expect(projected).toEqual(
        expect.arrayContaining([
          { type: "email", value: "keep@example.test" },
          { type: "instagram", value: settings.instagram },
        ]),
      );
      expect(projected).not.toEqual(
        expect.arrayContaining([{ type: "instagram", value: "https://example.test/private" }]),
      );
      expect(
        (
          await admin.query(
            "SELECT guest_count_enabled,default_currency FROM booking.booking_settings WHERE property_id=ANY($1::uuid[]) ORDER BY property_id",
            [properties],
          )
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          { guest_count_enabled: true, default_currency: "LKR" },
          { guest_count_enabled: true, default_currency: "EUR" },
        ]),
      );
      expect((await native.query("SELECT property_id FROM booking.booking_settings")).rows).toEqual(
        [{ property_id: properties[0] }],
      );
      expect(
        (
          await native.query(
            "UPDATE booking.booking_settings SET default_currency='USD' WHERE property_id=$1",
            [properties[1]],
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        native.query("UPDATE booking.booking_settings SET guest_count_enabled=FALSE"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await native.query(
            "DELETE FROM hotel_catalog.property_contact_channels WHERE channel_type='email'",
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        native.query(
          "UPDATE hotel_catalog.property_contact_channels SET is_public=TRUE WHERE value='https://example.test/private'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          `INSERT INTO platform.product_audit_events
        (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
         target_resource_product,target_resource_type,target_resource_id,redacted_payload,
         audit_metadata,retention_class,privacy_scope)
        VALUES($1,'hotel_catalog','property_launch_settings_updated',now(),'property',$2::uuid,
          'user',$3::uuid,'hotel_catalog','property',$2::uuid::text,
          '{"operation":"launch_settings"}',jsonb_build_object('actorOrganizationId',$4::uuid::text),
          'standard','internal')`,
          [randomUUID(), properties[0], randomUUID(), organizationId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        writeHotelSetupLaunchSettings(native, context, properties[0]!, {
          ...settings,
          instagram: "https://example.test/private",
        }),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT default_currency FROM booking.booking_settings WHERE property_id=$1",
            [properties[0]],
          )
        ).rows[0].default_currency,
      ).toBe("LKR");
      await expect(
        writeHotelSetupLaunchSettings(native, context, properties[1]!, settings),
      ).rejects.toThrow();
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='currency_ready' WHERE database_login=$1",
        [role],
      );
      await expect(
        writeHotelSetupLaunchSettings(native, context, properties[0]!, settings),
      ).rejects.toThrow();
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='launch_settings' WHERE database_login=$1",
        [role],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [role],
      );
      await expect(
        writeHotelSetupLaunchSettings(native, context, properties[0]!, settings),
      ).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM hotel_catalog.property_contact_channels WHERE property_id=ANY($1::uuid[]) AND channel_type='email'",
            [properties],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await native?.end();
      await ordinary?.end();
      // Only this fixture's rows, on the guarded local test database.
      await admin.query("BEGIN");
      await admin.query(
        "ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only",
      );
      await admin.query(
        "DELETE FROM platform.product_audit_events WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      await admin.query(
        "ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only",
      );
      await admin.query("COMMIT");
      await admin.query(
        "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
        [role],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query("DELETE FROM identity.organization_memberships WHERE organization_id=$1", [
        organizationId,
      ]);
      await admin.query("DELETE FROM identity.users WHERE id=$1", [userId]);
      await admin.query("DELETE FROM identity.role_permission_grants WHERE role_key=$1", [roleKey]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      if (roleCreated) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      if (ordinaryCreated) {
        await admin.query(`DROP OWNED BY ${ordinaryRole}`);
        await admin.query(`DROP ROLE ${ordinaryRole}`);
      }
      await admin.end();
    }
  }, 30_000);
});
