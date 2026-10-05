import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STSClient } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";
import { activateVerifiedHotelSetupPropertyRole } from "./hotelSetupPropertyRoleActivation.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { createHotelSetupLogoCredentialResolver } from "./hotelSetupCommandCredentials.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe.skipIf(!databaseUrl)("protected logo credential lifecycle", () => {
  it("proves pending credentials without media access before publishing an actor-bound immutable version", async () => {
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
    const organizationId = randomUUID(),
      actorUserId = randomUUID(),
      propertyId = randomUUID();
    const scope = { organizationId, actorUserId, propertyId, operation: "property_logo" as const };
    const suffix = randomUUID().replaceAll("-", "");
    const databaseAcls = (
      await admin.query<{ name: string; acl: string | null }>(
        "SELECT datname AS name,datacl::text AS acl FROM pg_database WHERE datallowconn ORDER BY datname",
      )
    ).rows;
    let login: string | undefined, native: pg.Client | undefined;
    try {
      for (const database of databaseAcls)
        await admin.query(
          `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
        );
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Logo lifecycle fixture',$2)",
        [organizationId, `logo-lifecycle-${suffix}`],
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
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1,$2,'Logo lifecycle fixture',$3)",
        [propertyId, `logo-${suffix}`, organizationId],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [organizationId, propertyId],
      );
      const staged = await stageHotelSetupPropertyRole({
        adminDatabaseUrl: databaseUrl!,
        databaseEndpoint: endpoint.toString(),
        scope,
      });
      login = staged.login;
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
      const send = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async (
        command: unknown,
      ) => {
        if (command instanceof DescribeSecretCommand) {
          throw Object.assign(new Error("synthetic absent secret"), {
            name: "ResourceNotFoundException",
          });
        }
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
      const resolve = createHotelSetupLogoCredentialResolver({
        assignments: admin,
        databaseEndpoint: endpoint.toString(),
        secretPrefix: "hotel-setup-command/prod/property/",
        readNativeSecret,
      });
      let secondaryFailure: unknown;
      const proveSecondary = vi.fn(
        async (
          client: pg.Client,
          proof: Parameters<typeof checkHotelSetupPropertyCredential>[1],
        ) => {
          try {
            expect(proof.bootstrapPending).toBe(true);
            expect(Object.isFrozen(proof)).toBe(true);
            await checkHotelSetupPropertyCredential(client, proof);
            await expect(checkHotelSetupPropertyCredential(client, scope)).rejects.toThrow(
              "scope preflight failed",
            );
            await expect(resolve(propertyId, organizationId, actorUserId)).rejects.toThrow(
              "Missing hotel setup logo assignment",
            );
            expect(readNativeSecret).not.toHaveBeenCalled();
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
            try {
              await expect(
                client.query("SELECT id FROM platform.media_upload_sessions"),
              ).resolves.toMatchObject({ rows: [] });
              await expect(
                client.query(
                  `INSERT INTO platform.media_upload_sessions
                (id,upload_session_key,requested_purpose,requested_visibility,actor_user_id,
                 owner_organization_id,property_id,resource_product,resource_type,resource_id,
                 staging_prefix,expires_at)
                VALUES($1,$2,'property.logo','private',$3,$4,$5,'hotel_catalog','property',$5::uuid::text,
                  $6,now()+interval '15 minutes')`,
                  [
                    randomUUID(),
                    `pending:${suffix}`,
                    actorUserId,
                    organizationId,
                    propertyId,
                    `staging/${randomUUID()}`,
                  ],
                ),
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
      const activated = await activateVerifiedHotelSetupPropertyRole({
        staged,
        adminDatabaseUrl: databaseUrl!,
        databaseEndpoint: endpoint.toString(),
        nativeDatabaseUrl: nativeUrl.toString(),
        proveSecondary,
        publish: true,
      }).catch((error) => {
        throw secondaryFailure ?? error;
      });
      expect(proveSecondary).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(3);
      expect(activated.publication?.versionId).toBe(versionId);
      const resolvedUrl = await resolve(propertyId, organizationId, actorUserId);
      expect(new URL(resolvedUrl).username).toBe(login);
      expect(readNativeSecret).toHaveBeenCalledWith(name, versionId);
      native = new pg.Client({ connectionString: resolvedUrl });
      await native.connect();
      await checkHotelSetupPropertyCredential(native, scope);
      readNativeSecret.mockClear();
      await expect(resolve(propertyId, organizationId, randomUUID())).rejects.toThrow(
        "Missing hotel setup logo assignment",
      );
      expect(readNativeSecret).not.toHaveBeenCalled();
      await admin.query(
        "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1 AND user_id=$2",
        [organizationId, actorUserId],
      );
      await expect(checkHotelSetupPropertyCredential(native, scope)).rejects.toThrow(
        "scope preflight failed",
      );
      await expect(resolve(propertyId, organizationId, actorUserId)).rejects.toThrow(
        "Missing hotel setup logo assignment",
      );
    } finally {
      await native?.end();
      if (login) {
        await admin.query(
          "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
          [login],
        );
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
      }
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await admin.query("DELETE FROM identity.organization_memberships WHERE organization_id=$1", [
        organizationId,
      ]);
      await admin.query("DELETE FROM identity.users WHERE id=$1", [actorUserId]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      for (const database of databaseAcls)
        await admin.query("UPDATE pg_database SET datacl=$1::aclitem[] WHERE datname=$2", [
          database.acl,
          database.name,
        ]);
      await admin.end();
    }
  }, 30_000);
});
