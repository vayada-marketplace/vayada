import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createOrdinaryHotelSetupLaunchSettingsCommand } from "./hotelSetupLaunchSettingsRepository.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { BookingContactPublicationConflictError } from "./routes/bookingSettings.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ordinary launch settings (VAY-2056)", () => {
  it("saves only the eight fields for the current Owner and holds the native scope rules", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const save = createOrdinaryHotelSetupLaunchSettingsCommand(pool);
    const suffix = randomUUID().replaceAll("-", "");
    const [org, foreignOrg, owner, property] = [1, 2, 3, 4].map(() => randomUUID());
    const context = (organizationId = org, sessionId: string | null = "verified-session") =>
      ({
        actor: { internalUserId: owner, providerIdentity: { sessionId } },
        selectedOrganization: { organizationId },
        audit: { requestId: suffix },
      }) as unknown as RequestContext;
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
    const one = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows[0];
    try {
      for (const [id, slug] of [
        [org, `l${suffix}`],
        [foreignOrg, `x${suffix}`],
      ] as const)
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Launch fixture',$2)",
          [id, slug],
        );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        owner,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Launch fixture',$2)",
        [property, org],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')",
        [org, property],
      );
      await admin.query("INSERT INTO booking.booking_settings(property_id) VALUES($1)", [property]);
      await admin.query(
        "INSERT INTO hotel_catalog.property_public_profile_read_model(property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status) VALUES($1::uuid,$1::uuid::text,'Launch fixture',$1::uuid::text,'en',ARRAY['en'],'incomplete')",
        [property],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,is_public,source_system) VALUES($1,'email','keep@example.test',TRUE,'booking'),($1,'instagram','https://example.test/private',FALSE,'platform')",
        [property],
      );

      // Saved twice: same values, no profile revision bump (native semantics, decision 4).
      expect(await save(context(), property, settings)).toEqual(settings);
      expect(await save(context(), property, settings)).toEqual(settings);
      expect(
        await one(
          "SELECT default_currency::text,supported_currencies FROM booking.booking_settings WHERE property_id=$1",
          [property],
        ),
      ).toEqual({ default_currency: "LKR", supported_currencies: ["USD"] });
      expect(
        (await one("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [property]))
          .profile_revision,
      ).toBe("1");
      expect(
        (
          await one(
            "SELECT public_contacts FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
            [property],
          )
        ).public_contacts,
      ).toEqual(
        expect.arrayContaining([
          { type: "email", value: "keep@example.test" },
          { type: "instagram", value: settings.instagram },
        ]),
      );
      const audits = async () =>
        Number(
          (
            await one(
              "SELECT count(*) AS n FROM platform.product_audit_events WHERE property_id=$1 AND action='property_launch_settings_updated' AND actor_user_id=$2",
              [property, owner],
            )
          ).n,
        );
      expect(await audits()).toBe(2);

      // A private contact is never published.
      await expect(
        save(context(), property, { ...settings, instagram: "https://example.test/private" }),
      ).rejects.toBeInstanceOf(BookingContactPublicationConflictError);

      // Missing session, foreign organization and every revocation deny before any write.
      await expect(save(context(org, null), property, settings)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(save(context(foreignOrg), property, settings)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      for (const [revoke, restore, id] of [
        [
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE product='pms' AND resource_id=$1::text",
          "UPDATE identity.organization_resource_links SET status='active' WHERE product='pms' AND resource_id=$1::text",
          property,
        ],
        [
          "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
          "UPDATE identity.organizations SET status='active' WHERE id=$1",
          org,
        ],
        [
          `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["hotel_catalog.setup.manage"]}' WHERE user_id=$1`,
          "UPDATE identity.organization_memberships SET permission_overrides=NULL WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.users SET status='suspended' WHERE id=$1",
          "UPDATE identity.users SET status='active' WHERE id=$1",
          owner,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        await expect(save(context(), property, settings)).rejects.toBeInstanceOf(
          AuthorizationError,
        );
        await admin.query(restore, [id]);
      }
      expect(await audits()).toBe(2);

      // The organization row lock serializes the save behind a concurrent revocation.
      await admin.query("BEGIN");
      await admin.query("UPDATE identity.organizations SET status='suspended' WHERE id=$1", [org]);
      const pending = save(context(), property, settings);
      for (let attempt = 0; ; attempt++) {
        await admin.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
        const waiting = await one(
          "SELECT count(*) AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
          [fixture.login],
        );
        if (Number(waiting.n) === 1) break;
        if (attempt > 400)
          throw new Error("Launch settings save did not wait for the organization");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(AuthorizationError);
      await admin.query("UPDATE identity.organizations SET status='active' WHERE id=$1", [org]);
      expect(await audits()).toBe(2);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
