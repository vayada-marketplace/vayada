import { randomUUID } from "node:crypto";
import { STSClient } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { createHotelSetupActorCredentialResolver } from "./hotelSetupCommandCredentials.js";
import { writeHotelSetupPropertyProfile } from "./hotelSetupProfileCommands.js";
import { activateVerifiedHotelSetupPropertyRole } from "./hotelSetupPropertyRoleActivation.js";
import { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";

const databaseUrl = process.env["HOTEL_SETUP_PROPERTY_STAGE_TEST_DATABASE_URL"];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!databaseUrl)("protected profile credential lifecycle", () => {
  it("proves a pending profile login without data access, then edits only as the current Owner", async () => {
    const url = new URL(databaseUrl!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_") ||
      !url.pathname.includes("test")
    )
      throw new Error("Owned local test database required");
    const endpoint = new URL(url);
    endpoint.username = endpoint.password = endpoint.search = "";
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const [organizationId, actorUserId, propertyId] = [randomUUID(), randomUUID(), randomUUID()];
    const scope = {
      organizationId,
      actorUserId,
      propertyId,
      operation: "property_profile" as const,
    };
    const suffix = randomUUID().replaceAll("-", "");
    const databaseAcls = (
      await admin.query<{ name: string; acl: string | null }>(
        "SELECT datname AS name,datacl::text AS acl FROM pg_database WHERE datallowconn ORDER BY datname",
      )
    ).rows;
    let login: string | undefined;
    try {
      for (const database of databaseAcls)
        await admin.query(
          `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
        );
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Profile lifecycle',$2)",
        [organizationId, `profile-lifecycle-${suffix}`],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        actorUserId,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled,booking_access_enabled) VALUES($1,$2,'hotel_owner','agency','all',FALSE,FALSE)",
        [organizationId, actorUserId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,property_type,creation_organization_id) VALUES($1,$2,'Profile lifecycle','hotel',$3)",
        [propertyId, `profile-${suffix}`, organizationId],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [organizationId, propertyId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,country_code,city,street_address,postal_code,timezone) VALUES($1,'LK','Galle','Old Road','80000','Asia/Colombo')",
        [propertyId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,purpose,is_public,source_system) VALUES($1,'email','front@example.test','guest',TRUE,'platform'),($1,'phone','+94 11 000 0000','guest',FALSE,'platform')",
        [propertyId],
      );

      const staged = await stageHotelSetupPropertyRole({
        adminDatabaseUrl: databaseUrl!,
        databaseEndpoint: endpoint.toString(),
        scope,
      });
      login = staged.login;
      expect(login).toMatch(/^vayada_next_hotel_setup_profile_[a-f0-9]{16}_[a-f0-9]{12}$/);
      // The staged identity owns no table privilege; only the parent grants fixed routines.
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_class c
             WHERE c.relnamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)
               AND pg_catalog.has_schema_privilege($1,c.relnamespace,'USAGE')
               AND (pg_catalog.has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR pg_catalog.has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`,
            [login],
          )
        ).rows[0].n,
      ).toBe(0);

      const nativeUrl = new URL(url);
      nativeUrl.username = login;
      nativeUrl.password = randomUUID() + randomUUID();
      vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
      vi.stubEnv("AWS_PROFILE", undefined);
      vi.spyOn(STSClient.prototype, "send").mockResolvedValue({ Account: "269416271598" } as never);
      let versionId = "",
        secretString = "";
      const name = `hotel-setup-command/prod/property/${login}`;
      const arn = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`;
      vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async (
        command: unknown,
      ) => {
        if (command instanceof DescribeSecretCommand)
          throw Object.assign(new Error("synthetic absent secret"), {
            name: "ResourceNotFoundException",
          });
        if (command instanceof CreateSecretCommand) {
          versionId = command.input.ClientRequestToken!;
          secretString = command.input.SecretString!;
          return { ARN: arn, Name: name, VersionId: versionId };
        }
        expect(command).toBeInstanceOf(GetSecretValueCommand);
        return { ARN: arn, Name: name, VersionId: versionId, SecretString: secretString };
      }) as never);
      const readNativeSecret = vi.fn(
        async () => JSON.parse(secretString) as { username: string; password: string },
      );
      const resolve = createHotelSetupActorCredentialResolver(
        {
          assignments: admin,
          databaseEndpoint: endpoint.toString(),
          secretPrefix: "hotel-setup-command/prod/property/",
          readNativeSecret,
        },
        "property_profile",
      );
      let secondaryFailure: unknown;
      const proveSecondary = vi.fn(
        async (
          client: pg.Client,
          proof: Parameters<typeof checkHotelSetupPropertyCredential>[1],
        ) => {
          try {
            expect(proof.bootstrapPending).toBe(true);
            await checkHotelSetupPropertyCredential(client, proof);
            await expect(checkHotelSetupPropertyCredential(client, scope)).rejects.toThrow(
              "scope preflight failed",
            );
            await expect(resolve(propertyId, organizationId, actorUserId)).rejects.toThrow(
              "Missing hotel setup profile assignment",
            );
            await client.query("BEGIN");
            try {
              await expect(
                client.query("SELECT platform.hotel_setup_property_profile_snapshot($1,$2,$3)", [
                  propertyId,
                  organizationId,
                  actorUserId,
                ]),
              ).rejects.toMatchObject({ code: "42501" });
            } finally {
              await client.query("ROLLBACK");
            }
          } catch (error) {
            secondaryFailure = error;
            throw error;
          }
        },
      );
      const receipt = await activateVerifiedHotelSetupPropertyRole({
        adminDatabaseUrl: databaseUrl!,
        databaseEndpoint: endpoint.toString(),
        nativeDatabaseUrl: nativeUrl.toString(),
        staged,
        proveSecondary,
        publish: true,
      });
      expect(secondaryFailure).toBeUndefined();
      expect(receipt).toMatchObject({ operation: "property_profile", actorUserId, propertyId });
      expect(
        (
          await admin.query(
            "SELECT actor_user_id::text,credential_ready_at IS NOT NULL AS ready FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
            [login],
          )
        ).rows,
      ).toEqual([{ actor_user_id: actorUserId, ready: true }]);

      // Ready: the resolved credential passes the exact native attestation and edits.
      const pool = new pg.Pool({
        connectionString: await resolve(propertyId, organizationId, actorUserId),
        max: 1,
      });
      try {
        const ids = { propertyId, organizationId, actorUserId };
        const revision = Number(
          (
            await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
              propertyId,
            ])
          ).rows[0].profile_revision,
        );
        const edit: Parameters<typeof writeHotelSetupPropertyProfile>[3] = {
          idempotencyKey: "lifecycle-1",
          fingerprint: "a".repeat(64),
          merge: (existing) => ({
            expectedProfileRevision: revision,
            profile: { ...existing, displayName: "Profile lifecycle TEST ONLY" },
          }),
        };
        // Any widened privilege fails closed before reading or writing.
        for (const [grant, revoke] of [
          [
            `GRANT SELECT(display_name) ON hotel_catalog.properties TO ${login}`,
            `REVOKE SELECT(display_name) ON hotel_catalog.properties FROM ${login}`,
          ],
          [
            `GRANT EXECUTE ON FUNCTION platform.hotel_setup_profile_authority(uuid,uuid,uuid,boolean) TO ${login}`,
            `REVOKE EXECUTE ON FUNCTION platform.hotel_setup_profile_authority(uuid,uuid,uuid,boolean) FROM ${login}`,
          ],
        ]) {
          await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${login}`);
          await admin.query(grant!);
          await expect(
            writeHotelSetupPropertyProfile(pool, ids, "lifecycle", edit),
          ).rejects.toThrow("native inventory mismatch");
          await admin.query(revoke!);
          await admin.query(`REVOKE USAGE ON SCHEMA hotel_catalog FROM ${login}`);
        }
        const saved = await writeHotelSetupPropertyProfile(pool, ids, "lifecycle", edit);
        expect(saved).toMatchObject({
          status: "updated",
          profile: { profile: { displayName: "Profile lifecycle TEST ONLY" } },
        });
        expect(
          (saved as { profile: { profile: { contacts: unknown } } }).profile.profile.contacts,
        ).toEqual([
          { channelType: "email", value: "front@example.test", purpose: "guest", isPublic: true },
          { channelType: "phone", value: "+94 11 000 0000", purpose: "guest", isPublic: false },
        ]);
        await admin.query(
          "UPDATE identity.organization_memberships SET role_key='hotel_manager' WHERE user_id=$1",
          [actorUserId],
        );
        await expect(
          writeHotelSetupPropertyProfile(pool, ids, "lifecycle", edit),
        ).rejects.toBeInstanceOf(AuthorizationError);
      } finally {
        await pool.end();
      }
    } finally {
      if (login) {
        await admin.query(
          "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
          [login],
        );
        // Remove the staged CONNECT grant through dependency tracking before restoring ACLs.
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
      }
      for (const database of databaseAcls)
        await admin.query("UPDATE pg_database SET datacl=$1::aclitem[] WHERE datname=$2", [
          database.acl,
          database.name,
        ]);
      await admin.end();
    }
  }, 30_000);
});
