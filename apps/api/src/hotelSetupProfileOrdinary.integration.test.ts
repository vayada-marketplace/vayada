import { createHash, randomUUID } from "node:crypto";
import type { PropertyProfile, PropertyProfileContact } from "@vayada/domain-hotels";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { writeOrdinaryHotelSetupPropertyProfile } from "./platform/hotelSetupProfileWriter.js";

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function profile(
  name: string,
  contacts: PropertyProfileContact[],
  location: Partial<PropertyProfile["location"]> = {},
): PropertyProfile {
  return {
    displayName: name,
    propertyType: "hotel",
    location: {
      countryCode: "LK",
      city: "Ahangama",
      streetAddress: "1 Beach Road",
      postalCode: "80650",
      timezone: "Asia/Colombo",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
      ...location,
    },
    contacts,
  };
}

describe.skipIf(!url)("ordinary property profile writer (VAY-2056)", () => {
  it("keeps the native writer's authority, replay, revision and privacy rules on the ordinary login", async () => {
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
    const racer = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const [org, foreignOrg, owner, foreignOwner, manager] = [1, 2, 3, 4, 5].map(() => randomUUID());
    const [property, foreignProperty] = [randomUUID(), randomUUID()];
    const count = async (sql: string, values: unknown[] = []) =>
      Number((await admin.query<{ n: string }>(sql, values)).rows[0]!.n);
    try {
      for (const [id, user, slug] of [
        [org, owner, `o${suffix}`],
        [foreignOrg, foreignOwner, `f${suffix}`],
      ] as const) {
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Ordinary profile',$2)",
          [id, slug],
        );
        await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
          user,
          `${slug}@example.test`,
        ]);
        await admin.query(
          "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
          [id, user],
        );
      }
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        manager,
        `m${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_manager','agency','all')",
        [org, manager],
      );
      for (const [id, organization] of [
        [property, org],
        [foreignProperty, foreignOrg],
      ] as const) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,property_type,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Profile fixture','hotel',$2)",
          [id, organization],
        );
        await admin.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
          [organization, id],
        );
        await admin.query(
          "INSERT INTO hotel_catalog.property_locations(property_id,country_code,city,street_address,postal_code,timezone,address_public,geo_public,map_display_mode) VALUES($1,'LK','Galle','Old Road','80000','Asia/Colombo',TRUE,FALSE,'hidden')",
          [id],
        );
        await admin.query(
          `INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,purpose,is_public,source_system) VALUES
           ($1,'email','front@example.test','guest',TRUE,'platform'),
           ($1,'email','owner-account@example.test','general',FALSE,'booking'),
           ($1,'instagram','https://example.test/social','general',TRUE,'booking')`,
          [id],
        );
      }

      const write = (
        scope: [string, string, string],
        key: string,
        next: PropertyProfile,
        revision: number,
        fingerprint = key,
        on = pool,
      ) =>
        writeOrdinaryHotelSetupPropertyProfile(
          on,
          { propertyId: scope[0], organizationId: scope[1], actorUserId: scope[2] },
          "request-1",
          {
            idempotencyKey: key,
            fingerprint: hash(fingerprint),
            merge: () => ({ expectedProfileRevision: revision, profile: next }),
          },
        );
      const bound: [string, string, string] = [property, org, owner];
      const contacts: PropertyProfileContact[] = [
        { channelType: "email", value: "hello@example.test", purpose: "guest", isPublic: true },
        { channelType: "phone", value: "+94 77 123 4567", purpose: "guest", isPublic: true },
        {
          channelType: "website",
          value: "https://hotel.example.test/",
          purpose: "general",
          isPublic: false,
        },
      ];
      const edited = profile("Animals Ahangama TEST ONLY", contacts);
      const audits = () =>
        admin.query(
          "SELECT actor_user_id::text,audit_metadata,redacted_payload FROM platform.product_audit_events WHERE property_id=$1 AND action='property_profile_updated' ORDER BY occurred_at",
          [property],
        );

      // Foreign property, organization or actor and a non-Owner member deny before any write.
      for (const scope of [
        [foreignProperty, org, owner],
        [property, foreignOrg, owner],
        [property, org, foreignOwner],
        [property, org, manager],
      ] as [string, string, string][])
        await expect(write(scope, "forged", edited, 1)).rejects.toBeInstanceOf(AuthorizationError);

      // A failed write rolls back everything; hidden contacts are never published or re-owned.
      await expect(
        write(
          bound,
          "bad",
          profile("Rolled back", [
            { ...contacts[0]!, channelType: "fax" as PropertyProfileContact["channelType"] },
          ]),
          1,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      for (const hidden of [
        {
          channelType: "email",
          value: "owner-account@example.test",
          purpose: "guest",
          isPublic: true,
        },
        {
          channelType: "instagram",
          value: "https://example.test/social",
          purpose: "general",
          isPublic: false,
        },
      ] as PropertyProfileContact[])
        expect(await write(bound, "hidden", profile("Hidden", [...contacts, hidden]), 1)).toEqual({
          status: "private_contact_conflict",
        });
      expect(
        await count("SELECT count(*) AS n FROM platform.idempotency_keys WHERE property_id=$1", [
          property,
        ]),
      ).toBe(0);

      const saved = await write(bound, "key-1", edited, 1);
      expect(saved).toMatchObject({
        status: "updated",
        profile: {
          profileRevision: 2,
          profile: {
            displayName: "Animals Ahangama TEST ONLY",
            location: { localityPublic: false },
          },
        },
      });
      expect(
        (
          await admin.query(
            "SELECT channel_type,value,is_public,source_system FROM hotel_catalog.property_contact_channels WHERE property_id=$1 AND source_system<>'platform' ORDER BY 1,2",
            [property],
          )
        ).rows,
      ).toEqual([
        {
          channel_type: "email",
          value: "owner-account@example.test",
          is_public: false,
          source_system: "booking",
        },
        {
          channel_type: "instagram",
          value: "https://example.test/social",
          is_public: true,
          source_system: "booking",
        },
      ]);
      const projection = (
        await admin.query(
          "SELECT display_name,public_contacts FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
          [property],
        )
      ).rows[0];
      expect(projection.display_name).toBe("Animals Ahangama TEST ONLY");
      expect(projection.public_contacts).toEqual([
        { type: "email", value: "hello@example.test" },
        { type: "instagram", value: "https://example.test/social" },
        { type: "phone", value: "+94 77 123 4567" },
      ]);
      expect((await audits()).rows).toEqual([
        {
          actor_user_id: owner,
          audit_metadata: { actorOrganizationId: org },
          redacted_payload: {
            operation: "property_profile",
            changedFields: [
              "city",
              "contacts",
              "displayName",
              "localityPublic",
              "postalCode",
              "streetAddress",
            ],
            profileRevision: 2,
          },
        },
      ]);

      // Replay writes nothing; a changed body under the same key and a stale revision conflict.
      expect(await write(bound, "key-1", edited, 1)).toMatchObject({
        status: "replayed",
        profile: { profileRevision: 2 },
      });
      expect(await write(bound, "key-1", profile("Changed", contacts), 1, "other")).toEqual({
        status: "idempotency_conflict",
      });
      expect(await write(bound, "key-2", profile("Stale", contacts), 1)).toEqual({
        status: "conflict",
        currentRevision: 2,
      });
      expect((await audits()).rows).toHaveLength(1);

      // Publishing locality is an explicit, consented field change.
      expect(
        await write(
          bound,
          "key-3",
          profile("Animals Ahangama TEST ONLY", contacts, { localityPublic: true }),
          2,
        ),
      ).toMatchObject({
        status: "updated",
        profile: { profile: { location: { localityPublic: true } } },
      });

      // The foreign hotel never changed.
      expect(
        await count(
          "SELECT count(*) AS n FROM hotel_catalog.properties WHERE id=$1 AND display_name='Profile fixture' AND profile_revision=1",
          [foreignProperty],
        ),
      ).toBe(1);

      // Revocation denies first attempts and replays of completed keys.
      for (const [revoke, restore, id] of [
        [
          "UPDATE identity.organization_memberships SET role_key='hotel_manager' WHERE user_id=$1",
          "UPDATE identity.organization_memberships SET role_key='hotel_owner' WHERE user_id=$1",
          owner,
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
        [
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE resource_id=$1::text",
          "UPDATE identity.organization_resource_links SET status='active' WHERE resource_id=$1::text",
          property,
        ],
        [
          "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
          "UPDATE identity.organizations SET status='active' WHERE id=$1",
          org,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        await expect(write(bound, "key-1", edited, 1)).rejects.toBeInstanceOf(AuthorizationError);
        await expect(write(bound, "key-4", edited, 3)).rejects.toBeInstanceOf(AuthorizationError);
        await admin.query(restore, [id]);
      }
      expect((await audits()).rows).toHaveLength(2);

      // Two connections race on the organization lock: one revision writes, the other conflicts.
      await admin.query("BEGIN");
      await admin.query("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE", [org]);
      const race = Promise.all([
        write(bound, "race-a", profile("Race A", contacts), 3, "race-a", pool),
        write(bound, "race-b", profile("Race B", contacts), 3, "race-b", racer),
      ]);
      for (let attempt = 0; ; attempt++) {
        await admin.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
        if (
          (await count(
            "SELECT count(*) AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
            [fixture.login],
          )) === 2
        )
          break;
        if (attempt > 400) throw new Error("Profile writers did not overlap");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query("COMMIT");
      expect((await race).map((result) => result.status).sort()).toEqual(["conflict", "updated"]);
      expect((await audits()).rows).toHaveLength(3);

      // VAY-2322 F2: the area or village and arrival directions are saved, read back and cleared with "".
      const located = (area: string, arrivalDirections: string) =>
        profile("Race A", contacts, { area, arrivalDirections });
      expect(
        await write(
          bound,
          "arrival",
          located("Kathaluwa", "Turn at the blue gate after the temple."),
          4,
        ),
      ).toMatchObject({
        status: "updated",
        profile: {
          profile: {
            location: {
              area: "Kathaluwa",
              arrivalDirections: "Turn at the blue gate after the temple.",
            },
          },
        },
      });
      const stored = () =>
        admin
          .query(
            "SELECT area,arrival_directions FROM hotel_catalog.property_locations WHERE property_id=$1",
            [property],
          )
          .then((result) => result.rows[0]);
      expect(await stored()).toEqual({
        area: "Kathaluwa",
        arrival_directions: "Turn at the blue gate after the temple.",
      });
      const cleared = await write(bound, "arrival-cleared", located("", ""), 5);
      expect(cleared).toMatchObject({ status: "updated" });
      // Empty fields are left out of the profile, as clients from before them expect.
      expect(
        (cleared as { profile: { profile: { location: object } } }).profile.profile.location,
      ).not.toHaveProperty("area");
      expect(await stored()).toEqual({ area: null, arrival_directions: null });
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await pool.end();
      await racer.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);

  it("never moves a live hotel's time zone or country without a confirmation, nor away from its Channex property's (VAY-2582)", async () => {
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
    const suffix = randomUUID().replaceAll("-", "");
    const [org, owner, property, channexProperty] = [1, 2, 3, 4].map(() => randomUUID());
    const scope = { propertyId: property, organizationId: org, actorUserId: owner };
    const contacts: PropertyProfileContact[] = [
      { channelType: "email", value: "hello@example.test", purpose: "guest", isPublic: true },
    ];
    const dikwella = { countryCode: "LK", city: "Dikwella", timezone: "Asia/Colombo" };
    const sheffield = {
      countryCode: "GB",
      city: "Sheffield",
      streetAddress: "London Road",
      postalCode: "S2 4LA",
      timezone: "Europe/London",
      latitude: 53.37,
      longitude: -1.47,
    };
    const channexZones: string[] = [];
    let channexZone: string | Error = "Asia/Colombo";
    const readChannex = async (id: string) => {
      channexZones.push(id);
      if (channexZone instanceof Error) throw channexZone;
      return channexZone;
    };
    let key = 0;
    const revision = async () =>
      Number(
        (
          await admin.query<{ r: string }>(
            "SELECT profile_revision AS r FROM hotel_catalog.properties WHERE id=$1",
            [property],
          )
        ).rows[0]!.r,
      );
    // The merge sends the revision it read, as clients send the one they loaded.
    const at = async (
      location: Partial<PropertyProfile["location"]>,
      confirm?: boolean,
      reader: typeof readChannex | null = readChannex,
    ) => {
      const expected = await revision();
      key += 1;
      return writeOrdinaryHotelSetupPropertyProfile(
        pool,
        scope,
        "request-2582",
        {
          idempotencyKey: `vay-2582-${key}`,
          fingerprint: hash(`vay-2582-${key}`),
          merge: () => ({
            expectedProfileRevision: expected,
            profile: profile("Aether TEST ONLY", contacts, { ...dikwella, ...location }),
            ...(confirm === undefined ? {} : { confirmLocationChange: confirm }),
          }),
        },
        reader ?? undefined,
      );
    };
    const stored = () =>
      admin
        .query(
          "SELECT country_code,city,street_address,timezone FROM hotel_catalog.property_locations WHERE property_id=$1",
          [property],
        )
        .then((result) => result.rows[0]);
    const writes = async () => ({
      revision: await revision(),
      keys: Number(
        (
          await admin.query<{ n: string }>(
            "SELECT count(*) AS n FROM platform.idempotency_keys WHERE property_id=$1",
            [property],
          )
        ).rows[0]!.n,
      ),
    });
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Live hotel',$2)",
        [org, `l${suffix}`],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        owner,
        `l${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,property_type,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Aether TEST ONLY','hotel',$2)",
        [property, org],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [org, property],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,country_code,city,street_address,postal_code,timezone,address_public,geo_public,map_display_mode) VALUES($1,'LK','Dikwella','Beach Road','81200','Asia/Colombo',FALSE,FALSE,'hidden')",
        [property],
      );

      // A hotel in setup moves freely: its address search picks the time zone.
      expect(await at(sheffield)).toMatchObject({ status: "updated" });
      expect(await stored()).toMatchObject({ country_code: "GB", timezone: "Europe/London" });
      expect(await at({})).toMatchObject({ status: "updated" });
      await admin.query(
        "UPDATE hotel_catalog.properties SET lifecycle_status='active' WHERE id=$1",
        [property],
      );

      // Live: a new street, postal code and pin keep the time zone and country, and save.
      expect(
        await at({
          streetAddress: "Temple Road 4",
          postalCode: "81200",
          latitude: 5.97,
          longitude: 80.69,
        }),
      ).toMatchObject({
        status: "updated",
        profile: {
          profile: { location: { streetAddress: "Temple Road 4", timezone: "Asia/Colombo" } },
        },
      });

      // Live: the Sheffield address search (2026-11-21) is refused until confirmed, and writes nothing.
      const before = await writes();
      expect(await at(sheffield)).toEqual({
        status: "location_change_unconfirmed",
        changes: {
          timezone: { from: "Asia/Colombo", to: "Europe/London" },
          countryCode: { from: "LK", to: "GB" },
        },
      });
      expect(await at({ countryCode: "GB" }, false)).toEqual({
        status: "location_change_unconfirmed",
        changes: { countryCode: { from: "LK", to: "GB" } },
      });
      expect(await writes()).toEqual(before);
      expect(await stored()).toMatchObject({
        country_code: "LK",
        city: "Dikwella",
        timezone: "Asia/Colombo",
      });
      // Confirmed on purpose, it saves; and back again.
      expect(await at(sheffield, true)).toMatchObject({ status: "updated" });
      expect(await stored()).toMatchObject({ country_code: "GB", timezone: "Europe/London" });
      expect(await at({}, true)).toMatchObject({ status: "updated" });
      expect(channexZones).toEqual([]);

      // Connected to Channex (Asia/Colombo): another time zone is refused, even confirmed.
      await admin.query(
        "INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES($1,'channex','connected',$2)",
        [property, channexProperty],
      );
      const connected = await writes();
      expect(await at({ timezone: "Europe/London" }, true)).toEqual({
        status: "channex_time_zone_mismatch",
        channexTimeZone: "Asia/Colombo",
      });
      expect(channexZones).toEqual([channexProperty]);
      // Channex not answering, or not configured: nothing is saved.
      channexZone = new Error("channex down");
      expect(await at({ timezone: "Europe/London" }, true)).toEqual({
        status: "channex_time_zone_unavailable",
      });
      expect(await at({ timezone: "Europe/London" }, true, null)).toEqual({
        status: "channex_time_zone_unavailable",
      });
      expect(await writes()).toEqual(connected);
      // A street change on the connected hotel never asks Channex.
      channexZones.length = 0;
      expect(await at({ streetAddress: "Temple Road 5" })).toMatchObject({ status: "updated" });
      expect(channexZones).toEqual([]);
      // A hotel already off its Channex time zone may move back to it (confirmed, as it is live).
      channexZone = "Asia/Colombo";
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET timezone='Europe/London' WHERE property_id=$1",
        [property],
      );
      expect(await at({ timezone: "Asia/Colombo" }, true)).toMatchObject({ status: "updated" });
      expect(await stored()).toMatchObject({ timezone: "Asia/Colombo" });
      // A disconnected Channex property no longer holds the time zone.
      await admin.query(
        "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
        [property],
      );
      channexZones.length = 0;
      expect(await at({ timezone: "Asia/Kolkata" }, true)).toMatchObject({ status: "updated" });
      expect(channexZones).toEqual([]);
    } finally {
      await admin
        .query("DELETE FROM pms.channel_connections WHERE property_id=$1", [property])
        .catch(() => undefined);
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
