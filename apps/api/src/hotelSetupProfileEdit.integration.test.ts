import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const READY_VERSION = "a".repeat(32);

function profile(name: string, contacts: object[], location: Record<string, unknown> = {}) {
  return {
    display_name: name,
    property_type: "hotel",
    country_code: "LK",
    city: "Ahangama",
    street_address: "1 Beach Road",
    postal_code: "80650",
    timezone: "Asia/Colombo",
    latitude: null,
    longitude: null,
    address_public: false,
    geo_public: false,
    map_display_mode: "hidden",
    contacts,
    ...location,
  };
}

describe.skipIf(!url)("native property profile edit", () => {
  it("edits only its Owner-bound property atomically, replays once and keeps privacy explicit", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const suffix = randomUUID().replaceAll("-", "");
    const login = `vayada_next_hotel_setup_profile_${suffix.slice(0, 20)}`;
    const ordinaryRole = `vayada_test_profile_ordinary_${suffix.slice(0, 16)}`;
    const [org, foreignOrg, owner, foreignOwner] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const [property, sibling, foreignProperty] = [randomUUID(), randomUUID(), randomUUID()];
    const password = randomUUID();
    const admin = new pg.Client({ connectionString: url });
    const roles: string[] = [];
    const pools: pg.Pool[] = [];
    await admin.connect();
    const connect = (user: string) => {
      const target = new URL(url!);
      target.username = user;
      target.password = password;
      const pool = new pg.Pool({ connectionString: target.toString(), max: 1 });
      pools.push(pool);
      return pool;
    };
    const count = async (sql: string, values: unknown[] = []) =>
      Number((await admin.query<{ n: string }>(sql, values)).rows[0]!.n);
    try {
      for (const [id, user, slug] of [
        [org, owner, `p${suffix}`],
        [foreignOrg, foreignOwner, `f${suffix}`],
      ] as const) {
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Profile fixture',$2)",
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
      for (const [id, organization] of [
        [property, org],
        [sibling, org],
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
           ($1,'phone','+94 11 000 0000','guest',TRUE,'platform'),
           ($1,'email','owner-account@example.test','general',FALSE,'booking'),
           ($1,'instagram','https://example.test/social','general',TRUE,'booking')`,
          [id],
        );
      }
      await admin.query(
        `CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      roles.push(login);
      await admin.query(
        `GRANT vayada_next_hotel_setup_profile_scope TO ${login} WITH INHERIT TRUE, SET FALSE`,
      );
      await admin.query(
        `INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class,actor_user_id)
         VALUES($1,$2,$3,'property_profile',$4)`,
        [login, property, org, owner],
      );
      const native = connect(login);
      const call = async (sql: string, values: unknown[], pool = native) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await client.query<{ value: Record<string, unknown> }>(sql, values);
          await client.query("COMMIT");
          return result.rows[0]?.value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      const snapshot = (scope: string[]) =>
        call("SELECT platform.hotel_setup_property_profile_snapshot($1,$2,$3) AS value", scope);
      const update = (
        scope: string[],
        revision: number,
        body: object,
        key: string,
        fingerprint = key,
        pool = native,
      ) =>
        call(
          "SELECT platform.hotel_setup_update_property_profile($1,$2,$3,$4,$5,$6,$7,'request-1') AS value",
          [...scope, revision, JSON.stringify(body), hash(key), hash(fingerprint)],
          pool,
        );
      const bound = [property, org, owner];

      // Pending assignment proves the credential only; it can neither read nor write.
      expect(
        (
          await native.query(
            "SELECT platform.hotel_setup_profile_bootstrap_proof_allowed($1,$2,$3) AS proof, platform.hotel_setup_profile_allowed($1,$2,$3) AS ready",
            bound,
          )
        ).rows[0],
      ).toEqual({ proof: true, ready: false });
      await expect(snapshot(bound)).rejects.toMatchObject({ code: "HSP03" });
      await admin.query(
        `UPDATE platform.hotel_setup_property_scopes SET credential_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1),
         credential_secret_version=$2,credential_ready_at=now() WHERE database_login=$1`,
        [login, READY_VERSION],
      );

      // The native login has no table privilege and cannot reach internal helpers.
      for (const sql of [
        "UPDATE hotel_catalog.properties SET display_name='x' WHERE id=$1",
        "SELECT display_name FROM hotel_catalog.properties WHERE id=$1",
        "DELETE FROM hotel_catalog.property_contact_channels WHERE property_id=$1",
        "SELECT platform.hotel_setup_sync_property_read_models($1)",
        "SELECT platform.hotel_setup_property_profile_row($1)",
        "SELECT platform.hotel_setup_profile_authority($1,NULL,NULL,FALSE)",
      ])
        await expect(native.query(sql, [property])).rejects.toMatchObject({ code: "42501" });
      expect(
        await count(
          `SELECT count(*) AS n FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) acl
           WHERE p.pronamespace='platform'::regnamespace AND p.proname IN ('hotel_setup_profile_authority',
             'hotel_setup_profile_allowed','hotel_setup_profile_bootstrap_proof_allowed','hotel_setup_property_profile_row',
             'hotel_setup_property_profile_snapshot','hotel_setup_update_property_profile','hotel_setup_sync_property_read_models')
             AND acl.grantee=0`,
        ),
      ).toBe(0);

      // A restricted ordinary identity keeps read access only.
      await admin.query(
        `CREATE ROLE ${ordinaryRole} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      roles.push(ordinaryRole);
      await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${ordinaryRole}`);
      await admin.query(`GRANT SELECT ON hotel_catalog.properties TO ${ordinaryRole}`);
      const ordinary = connect(ordinaryRole);
      await expect(
        ordinary.query("UPDATE hotel_catalog.properties SET display_name='x' WHERE id=$1", [
          property,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        ordinary.query("SELECT platform.hotel_setup_property_profile_snapshot($1,$2,$3)", bound),
      ).rejects.toMatchObject({ code: "42501" });

      // Foreign property, organization and actor all deny before any read or write.
      for (const scope of [
        [sibling, org, owner],
        [foreignProperty, foreignOrg, foreignOwner],
        [property, foreignOrg, owner],
        [property, org, foreignOwner],
      ]) {
        await expect(snapshot(scope)).rejects.toMatchObject({ code: "HSP03" });
        await expect(update(scope, 1, profile("Forged", []), "forged")).rejects.toMatchObject({
          code: "HSP03",
        });
      }

      const before = await snapshot(bound);
      expect(before).toMatchObject({ propertyId: property, displayName: "Profile fixture" });
      const revision = before!["profileRevision"] as number;
      const contacts = [
        { channel_type: "email", value: "hello@example.test", purpose: "guest", is_public: true },
        { channel_type: "phone", value: "+94 77 123 4567", purpose: "guest", is_public: true },
        {
          channel_type: "website",
          value: "https://hotel.example.test/",
          purpose: "general",
          is_public: false,
        },
      ];
      const edited = profile("Animals Ahangama TEST ONLY", contacts);

      // Failure rolls back everything: no revision, contact, projection, key or audit.
      await expect(
        update(
          bound,
          revision,
          profile("Rolled back", [{ ...contacts[0], channel_type: "fax" }]),
          "bad",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(update(bound, revision, profile("", contacts), "blank")).rejects.toMatchObject({
        code: "22023",
      });
      await expect(
        update(bound, revision, { ...profile("Typed", contacts), property_type: "castle" }, "type"),
      ).rejects.toMatchObject({ code: "22023" });
      // A hidden private contact or another product's social is never published or re-owned.
      for (const hidden of [
        {
          channel_type: "email",
          value: "owner-account@example.test",
          purpose: "guest",
          is_public: true,
        },
        {
          channel_type: "instagram",
          value: "https://example.test/social",
          purpose: "general",
          is_public: false,
        },
      ])
        expect(
          await update(bound, revision, profile("Hidden", [...contacts, hidden]), "hidden"),
        ).toEqual({ status: "private_contact_conflict" });
      expect(await snapshot(bound)).toEqual(before);

      const saved = await update(bound, revision, edited, "key-1");
      expect(saved).toMatchObject({
        status: "updated",
        profile: {
          profileRevision: revision + 1,
          displayName: "Animals Ahangama TEST ONLY",
          streetAddress: "1 Beach Road",
          city: "Ahangama",
          timezone: "Asia/Colombo",
          localityPublic: false,
        },
      });
      expect((saved!["profile"] as { contacts: unknown[] }).contacts).toEqual([
        { channelType: "email", value: "hello@example.test", purpose: "guest", isPublic: true },
        { channelType: "phone", value: "+94 77 123 4567", purpose: "guest", isPublic: true },
        {
          channelType: "website",
          value: "https://hotel.example.test/",
          purpose: "general",
          isPublic: false,
        },
      ]);
      // Hidden private and booking-owned social contacts are untouched; nothing is published.
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
          "SELECT display_name,location,public_contacts FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
          [property],
        )
      ).rows[0];
      expect(projection.display_name).toBe("Animals Ahangama TEST ONLY");
      expect(projection.location).toEqual({});
      expect(projection.public_contacts).toEqual([
        { type: "email", value: "hello@example.test" },
        { type: "instagram", value: "https://example.test/social" },
        { type: "phone", value: "+94 77 123 4567" },
      ]);
      const audits = () =>
        admin.query(
          "SELECT actor_user_id::text,audit_metadata,redacted_payload,idempotency_key_id IS NOT NULL AS keyed FROM platform.product_audit_events WHERE property_id=$1 AND action='property_profile_updated'",
          [property],
        );
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
            profileRevision: revision + 1,
          },
          keyed: true,
        },
      ]);

      // Replay returns the saved profile without a second revision, key or audit.
      expect(await update(bound, revision, edited, "key-1")).toMatchObject({
        status: "replayed",
        profile: { profileRevision: revision + 1 },
      });
      expect(await update(bound, revision, profile("Changed", contacts), "key-1", "other")).toEqual(
        {
          status: "idempotency_conflict",
        },
      );
      expect(await update(bound, revision, profile("Stale", contacts), "key-2")).toEqual({
        status: "conflict",
        currentRevision: revision + 1,
      });
      expect((await audits()).rows).toHaveLength(1);
      expect(
        await count(
          "SELECT count(*) AS n FROM platform.idempotency_keys WHERE property_id=$1 AND operation='hotel_setup_property_profile_update'",
          [property],
        ),
      ).toBe(1);

      // Consent is explicit: publishing locality is a deliberate field change.
      const published = await update(
        bound,
        revision + 1,
        profile("Animals Ahangama TEST ONLY", contacts, { address_public: true }),
        "key-3",
      );
      expect(published).toMatchObject({ status: "updated", profile: { localityPublic: true } });
      expect(
        (
          await admin.query(
            "SELECT location FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
            [property],
          )
        ).rows[0].location,
      ).toEqual({ city: "Ahangama", countryCode: "LK" });

      // Sibling and foreign properties never changed.
      expect(
        await count(
          "SELECT count(*) AS n FROM hotel_catalog.properties WHERE id=ANY($1::uuid[]) AND display_name='Profile fixture'",
          [[sibling, foreignProperty]],
        ),
      ).toBe(2);

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
          "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE property_id=$1",
          "UPDATE platform.hotel_setup_property_scopes SET active=TRUE WHERE property_id=$1",
          property,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        await expect(update(bound, revision, edited, "key-1")).rejects.toMatchObject({
          code: "HSP03",
        });
        await expect(snapshot(bound)).rejects.toMatchObject({ code: "HSP03" });
        await admin.query(restore, [id]);
      }
      expect(await snapshot(bound)).toMatchObject({ profileRevision: revision + 2 });
      expect((await audits()).rows).toHaveLength(2);

      // Two connections race. The organization lock serializes them: one revision
      // writes and the other conflicts; one key writes once and the other replays.
      const racer = connect(login);
      const race = await Promise.all([
        update(bound, revision + 2, profile("Race A", contacts), "race-a", "race-a", native),
        update(bound, revision + 2, profile("Race B", contacts), "race-b", "race-b", racer),
      ]);
      expect(race.map((result) => result!["status"]).sort()).toEqual(["conflict", "updated"]);
      const same = profile("Race C", contacts);
      const replay = await Promise.all([
        update(bound, revision + 3, same, "race-c", "race-c", native),
        update(bound, revision + 3, same, "race-c", "race-c", racer),
      ]);
      expect(replay.map((result) => result!["status"]).sort()).toEqual(["replayed", "updated"]);
      expect(await snapshot(bound)).toMatchObject({
        profileRevision: revision + 4,
        displayName: "Race C",
      });
      expect((await audits()).rows).toHaveLength(4);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      for (const role of roles) {
        await admin.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`).catch(() => undefined);
        await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      }
      await admin.query(
        "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
        [login],
      );
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  }, 30_000);
});
