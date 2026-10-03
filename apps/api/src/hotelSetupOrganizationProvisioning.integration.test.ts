import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { STSClient } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { stageHotelSetupOrganizationRole } from "./hotelSetupOrganizationRoleStaging.js";
import { activateVerifiedHotelSetupOrganizationRole } from "./hotelSetupOrganizationRoleActivation.js";

const databaseUrl = process.env.HOTEL_SETUP_ORGANIZATION_BOOTSTRAP_TEST_DATABASE_URL;
describe.runIf(databaseUrl)(
  "automatic organization first publication on owned verified-TLS PostgreSQL",
  () => {
    it.each(["success", "proof", "publication", "readback", "readyCommit"])(
      "keeps %s exact and isolated",
      async (mode) => {
        const url = new URL(databaseUrl!);
        if (
          url.hostname !== "127.0.0.1" ||
          !url.pathname.startsWith("/vay1092_readiness_organization_test") ||
          url.search !== "?sslmode=verify-full"
        )
          throw new Error("Organization provisioning requires an owned disposable TLS fixture");
        const endpoint = new URL(url);
        endpoint.username = endpoint.password = endpoint.search = "";
        const admin = new pg.Client({ connectionString: url.toString() });
        await admin.connect();
        const databases = (
          await admin.query<{ name: string; privileges: string[] }>(`
          SELECT d.datname AS name,COALESCE(array_agg(a.privilege_type)
            FILTER(WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
          FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
          WHERE d.datallowconn GROUP BY d.datname`)
        ).rows;
        const scope = { organizationId: randomUUID(), actorUserId: randomUUID() };
        let staged: Awaited<ReturnType<typeof stageHotelSetupOrganizationRole>> | undefined;
        let versionId = "",
          secretString = "",
          name = "",
          arn = "";
        const before = (
          await admin.query(
            "SELECT (SELECT count(*) FROM hotel_catalog.properties)::text AS properties,(SELECT count(*) FROM platform.product_audit_events)::text AS audits",
          )
        ).rows;
        vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
        vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
        vi.stubEnv("AWS_PROFILE", undefined);
        vi.spyOn(STSClient.prototype, "send").mockResolvedValue({
          Account: "269416271598",
        } as never);
        const send = vi.fn(async (command: unknown) => {
          if (command instanceof DescribeSecretCommand) {
            const error = new Error();
            error.name = "ResourceNotFoundException";
            throw error;
          }
          if (command instanceof CreateSecretCommand) {
            name = command.input.Name!;
            versionId = command.input.ClientRequestToken!;
            secretString = command.input.SecretString!;
            if (mode === "publication") throw new Error("uncertain remote response");
            arn = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`;
            return { Name: name, VersionId: versionId, ARN: arn };
          }
          expect(command).toBeInstanceOf(GetSecretValueCommand);
          expect((command as GetSecretValueCommand).input).toEqual({
            SecretId: arn,
            VersionId: versionId,
          });
          return {
            Name: name,
            VersionId: versionId,
            ARN: arn,
            SecretString: mode === "readback" ? "mismatch" : secretString,
          };
        });
        vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(send as never);
        const originalQuery = pg.Client.prototype.query;
        let readyUpdate = false;
        if (mode === "readyCommit")
          vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
            this: pg.Client,
            ...args: unknown[]
          ) {
            const sql = args[0];
            const result = await (
              originalQuery as unknown as (...values: unknown[]) => Promise<unknown>
            ).apply(this, args);
            if (
              typeof sql === "string" &&
              sql.startsWith("UPDATE platform.hotel_setup_creation_scopes")
            )
              readyUpdate = true;
            if (sql === "COMMIT" && readyUpdate) {
              readyUpdate = false;
              throw new Error("lost readiness acknowledgement");
            }
            return result;
          } as never);
        try {
          for (const database of databases)
            await admin.query(
              `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
            );
          await admin.query(
            "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Synthetic organization',$1::uuid::text)",
            [scope.organizationId],
          );
          await admin.query(
            "INSERT INTO identity.users(id,email,name) VALUES($1,$1::uuid::text||'@example.test','Synthetic Owner')",
            [scope.actorUserId],
          );
          await admin.query(
            `INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,property_access_mode,pms_access_enabled,booking_access_enabled)
        VALUES($1,$2,'hotel_owner','all',false,false)`,
            [scope.organizationId, scope.actorUserId],
          );
          staged = await stageHotelSetupOrganizationRole({
            adminDatabaseUrl: url.toString(),
            databaseEndpoint: endpoint.toString(),
            scope,
          });
          expect(
            (
              await admin.query(
                "SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE oid=$1::oid",
                [staged.roleOid],
              )
            ).rows,
          ).toEqual([{ rolcanlogin: false, rolpassword: null }]);
          await expect(
            stageHotelSetupOrganizationRole({
              adminDatabaseUrl: url.toString(),
              databaseEndpoint: endpoint.toString(),
              scope,
            }),
          ).rejects.toThrow("staging failed");
          const native = new URL(url);
          native.username = staged.login;
          native.password = randomBytes(36).toString("base64url");
          const secondary = vi.fn(async (client: pg.Client, nativeScope: typeof scope) => {
            expect(
              (
                await admin.query(
                  "SELECT credential_ready_at FROM platform.hotel_setup_creation_scopes WHERE database_login=$1",
                  [staged!.login],
                )
              ).rows,
            ).toEqual([{ credential_ready_at: null }]);
            await checkHotelSetupCreationCredential(client, nativeScope);
            if (mode === "proof") throw new Error("failed rollback proof");
          });
          const run = activateVerifiedHotelSetupOrganizationRole({
            adminDatabaseUrl: url.toString(),
            nativeDatabaseUrl: native.toString(),
            databaseEndpoint: endpoint.toString(),
            staged,
            proveSecondary: secondary,
          });
          if (mode === "success")
            await expect(run).resolves.toMatchObject({
              ...staged,
              publication: { secretArn: expect.any(String), versionId: expect.any(String) },
            });
          else await expect(run).rejects.toThrow("requires recovery inspection");
          expect(secondary).toHaveBeenCalledOnce();
          const state = (
            await admin.query(
              "SELECT credential_role_oid,credential_secret_version,credential_ready_at FROM platform.hotel_setup_creation_scopes WHERE database_login=$1",
              [staged.login],
            )
          ).rows;
          if (["success", "readyCommit"].includes(mode)) {
            expect(state).toEqual([
              {
                credential_role_oid: staged.roleOid,
                credential_secret_version: versionId,
                credential_ready_at: expect.any(Date),
              },
            ]);
            expect(
              (
                await admin.query(
                  "SELECT rolcanlogin FROM pg_catalog.pg_authid WHERE oid=$1::oid",
                  [staged.roleOid],
                )
              ).rows,
            ).toEqual([{ rolcanlogin: true }]);
            const client = new pg.Client({ connectionString: native.toString() });
            await client.connect();
            try {
              await expect(
                checkHotelSetupCreationCredential(client, {
                  ...scope,
                  organizationId: randomUUID(),
                }),
              ).rejects.toThrow();
              await admin.query(
                "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1 AND user_id=$2",
                [scope.organizationId, scope.actorUserId],
              );
              await expect(checkHotelSetupCreationCredential(client, scope)).rejects.toThrow();
            } finally {
              await client.end();
            }
          } else {
            expect(state).toEqual([]);
            expect(
              (
                await admin.query(
                  "SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE oid=$1::oid",
                  [staged.roleOid],
                )
              ).rows,
            ).toEqual([{ rolcanlogin: false, rolpassword: null }]);
          }
          expect(
            (
              await admin.query(
                "SELECT (SELECT count(*) FROM hotel_catalog.properties)::text AS properties,(SELECT count(*) FROM platform.product_audit_events)::text AS audits",
              )
            ).rows,
          ).toEqual(before);
        } finally {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          await admin.query("ROLLBACK");
          if (staged) {
            await admin.query(
              "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 AND organization_id=$2",
              [staged.login, scope.organizationId],
            );
            await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(staged.login)}`);
            await admin.query(`DROP ROLE ${admin.escapeIdentifier(staged.login)}`);
          }
          await admin.query(
            "DELETE FROM identity.organization_memberships WHERE organization_id=$1",
            [scope.organizationId],
          );
          await admin.query("DELETE FROM identity.users WHERE id=$1", [scope.actorUserId]);
          await admin.query("DELETE FROM identity.organizations WHERE id=$1", [
            scope.organizationId,
          ]);
          for (const database of databases) {
            await admin.query(
              `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
            );
            if (database.privileges.length)
              await admin.query(
                `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
              );
          }
          await admin.end();
        }
      },
      60_000,
    );
  },
);
