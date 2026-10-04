import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { STSClient } from "@aws-sdk/client-sts";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_HOTEL_SETUP_BACKFILLS,
  backfillApprovedHotelSetupOrganizationReadiness,
} from "./hotelSetupApprovedReadinessBackfill.js";
import { HOTEL_SETUP_CREATION_PRIVILEGES } from "./hotelSetupCreationPrivileges.js";
import type { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";

const databaseUrl = process.env.HOTEL_SETUP_APPROVED_BACKFILL_TEST_DATABASE_URL;
const rollbackRoot = process.env.HOTEL_SETUP_APPROVED_BACKFILL_ROLLBACK_ROOT;
describe.runIf(databaseUrl && rollbackRoot)(
  "protected approved readiness on owned TLS PostgreSQL",
  () => {
    it("proves both legacy identities, fixed reader grants, failures and uncertain commits", async () => {
      const url = new URL(databaseUrl!);
      if (
        url.hostname !== "127.0.0.1" ||
        !url.pathname.startsWith("/vay1092_approved_backfill_test") ||
        url.search !== "?sslmode=verify-full" ||
        !isAbsolute(rollbackRoot!)
      )
        throw new Error("Owned isolated TLS fixture required");
      const root = await realpath(rollbackRoot!);
      if (
        root === (await realpath(new URL("../../../", import.meta.url))) ||
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !==
          "187eeea3a5d6864283b854815334fe34c7ec752b"
      )
        throw new Error("Independent reviewed rollback source required");
      execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: root });
      const secondary: {
        checkHotelSetupCreationCredential: typeof checkHotelSetupCreationCredential;
      } = await import(
        pathToFileURL(`${root}/apps/api/dist/cli/hotelSetupCreationPreflight.js`).href
      );
      const endpoint = new URL(url);
      endpoint.username = endpoint.password = endpoint.search = "";
      const admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      const fixedLogins = APPROVED_HOTEL_SETUP_BACKFILLS.map((b) => b.login);
      expect(
        (
          await admin.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [
            fixedLogins,
          ])
        ).rows,
      ).toEqual([]);
      const databases = (
        await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name,COALESCE(array_agg(a.privilege_type) FILTER(WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_database d LEFT JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
      ).rows;
      const operationalUrl = new URL(url);
      const owned = new Map<string, number>();
      const createdOrganizations = new Set<string>();
      const before = (
        await admin.query(
          "SELECT (SELECT count(*) FROM hotel_catalog.properties)::text AS properties,(SELECT count(*) FROM identity.product_entitlements)::text AS entitlements,(SELECT count(*) FROM platform.product_audit_events)::text AS audits",
        )
      ).rows;
      vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
      vi.stubEnv("AWS_PROFILE", undefined);
      const originalQuery = pg.Client.prototype.query;
      let committedAckFault = false;
      const removeOwnedRole = async (login: string) => {
        const oid = owned.get(login);
        if (!oid) return;
        expect(
          (await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [login])).rows,
        ).toEqual([{ oid }]);
        if (APPROVED_HOTEL_SETUP_BACKFILLS.some((binding) => binding.login === login)) {
          await admin.query(`SET ROLE ${admin.escapeIdentifier(operationalUrl.username)}`);
          try {
            await admin.query(
              `REVOKE INSERT(${HOTEL_SETUP_CREATION_PRIVILEGES["identity.product_entitlements"]!.INSERT!.join(",")}) ON identity.product_entitlements FROM ${admin.escapeIdentifier(login)}`,
            );
          } finally {
            await admin.query("RESET ROLE");
          }
        }
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
        owned.delete(login);
      };
      const createOwnedRole = async (login: string, password: string) => {
        await admin.query(
          `CREATE ROLE ${admin.escapeIdentifier(login)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(password)}`,
        );
        const oid: number = (
          await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [login])
        ).rows[0].oid;
        owned.set(login, oid);
        return oid;
      };
      try {
        const operatorLogin = `vay965_approved_operator_${randomUUID().replaceAll("-", "")}`;
        const operatorPassword = randomBytes(32).toString("base64url");
        await admin.query(`CREATE ROLE ${admin.escapeIdentifier(operatorLogin)} LOGIN NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS
          PASSWORD ${admin.escapeLiteral(operatorPassword)}`);
        const operatorOid = (
          await admin.query("SELECT oid FROM pg_roles WHERE rolname=$1", [operatorLogin])
        ).rows[0].oid;
        owned.set(operatorLogin, operatorOid);
        await admin.query(
          `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(url.pathname.slice(1))} TO ${admin.escapeIdentifier(operatorLogin)}`,
        );
        await admin.query(
          `GRANT USAGE ON SCHEMA identity,platform,hotel_catalog,pms TO ${admin.escapeIdentifier(operatorLogin)}`,
        );
        // Disposable fixture authority: catalog SELECT, deliberately never catalog UPDATE.
        await admin.query(
          `GRANT SELECT ON pg_catalog.pg_authid TO ${admin.escapeIdentifier(operatorLogin)}`,
        );
        await admin.query(
          `GRANT ALL ON ALL TABLES IN SCHEMA identity,platform,hotel_catalog,pms TO ${admin.escapeIdentifier(operatorLogin)} WITH GRANT OPTION`,
        );
        operationalUrl.username = operatorLogin;
        operationalUrl.password = operatorPassword;
        const operator = new pg.Client({ connectionString: operationalUrl.href });
        await operator.connect();
        try {
          expect(
            (
              await operator.query(`SELECT rolsuper,pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_authid','UPDATE') AS catalog_update
            FROM pg_roles WHERE rolname=current_user`)
            ).rows,
          ).toEqual([{ rolsuper: false, catalog_update: false }]);
        } finally {
          await operator.end();
        }
        expect(
          (
            await admin.query(
              "SELECT id FROM identity.organizations WHERE id=ANY($1::uuid[]) UNION ALL SELECT id FROM identity.users WHERE id=ANY($2::uuid[])",
              [
                APPROVED_HOTEL_SETUP_BACKFILLS.map((b) => b.organizationId),
                APPROVED_HOTEL_SETUP_BACKFILLS.map((b) => b.actorUserId),
              ],
            )
          ).rows,
        ).toEqual([]);
        for (const db of databases)
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(db.name)} FROM PUBLIC`,
          );
        await admin.query("SET lock_timeout='500ms'");
        for (const [index, binding] of APPROVED_HOTEL_SETUP_BACKFILLS.entries()) {
          await admin.query(
            "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Synthetic approved legacy',$1::uuid::text)",
            [binding.organizationId],
          );
          createdOrganizations.add(binding.organizationId);
          await admin.query(
            "INSERT INTO identity.users(id,email,name) VALUES($1,$1::uuid::text||'@example.test','Synthetic approved Owner')",
            [binding.actorUserId],
          );
          await admin.query(
            `INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled,booking_access_enabled)
          VALUES($1,$2,'hotel_owner','agency','all',false,false)`,
            [binding.organizationId, binding.actorUserId],
          );
          for (const mode of index === 0
            ? ["proof", "readback", "authority", "verifier", "assignment", "commitLost", "success"]
            : ["success"]) {
            const password = randomBytes(36).toString("base64url"),
              secretVersion = randomUUID();
            const oid = await createOwnedRole(binding.login, password);
            const role = admin.escapeIdentifier(binding.login);
            await admin.query(
              `GRANT vayada_next_hotel_setup_scope TO ${role} WITH INHERIT TRUE,SET FALSE`,
            );
            await admin.query(
              `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(decodeURIComponent(url.pathname.slice(1)))} TO ${role}`,
            );
            await admin.query(
              `GRANT USAGE ON SCHEMA ${[...new Set(Object.keys(HOTEL_SETUP_CREATION_PRIVILEGES).map((t) => t.split(".")[0]))].join(",")} TO ${role}`,
            );
            for (const [table, privileges] of Object.entries(HOTEL_SETUP_CREATION_PRIVILEGES))
              for (const [privilege, columns] of Object.entries(privileges))
                if (!(table === "identity.product_entitlements" && privilege === "INSERT"))
                  await admin.query(
                    `GRANT ${privilege}(${columns.join(",")}) ON ${table} TO ${role}`,
                  );
            await admin.query(
              "INSERT INTO platform.hotel_setup_creation_scopes(database_login,organization_id) VALUES($1,$2)",
              [binding.login, binding.organizationId],
            );
            const verifier = (
              await admin.query("SELECT rolpassword FROM pg_authid WHERE oid=$1::oid", [oid])
            ).rows[0].rolpassword;
            const native = new URL(url);
            native.username = binding.login;
            native.password = password;
            const inspected = { ...binding, expectedRoleOid: oid, secretVersion };
            const name = `hotel-setup-command/prod/organization/${binding.login}`;
            vi.spyOn(STSClient.prototype, "send").mockResolvedValue({
              Account: "269416271598",
            } as never);
            const send = vi
              .spyOn(SecretsManagerClient.prototype, "send")
              .mockImplementation(async (command: unknown) => {
                expect(command).toBeInstanceOf(GetSecretValueCommand);
                expect((command as GetSecretValueCommand).input).toEqual({
                  SecretId: name,
                  VersionId: secretVersion,
                });
                // A separate admin can lock the same organization and membership while remote IO executes.
                await admin.query("BEGIN");
                await admin.query("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE", [
                  binding.organizationId,
                ]);
                await admin.query(
                  "SELECT id FROM identity.organization_memberships WHERE organization_id=$1 FOR UPDATE",
                  [binding.organizationId],
                );
                await admin.query("ROLLBACK");
                return {
                  Name: name,
                  VersionId: secretVersion,
                  ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`,
                  SecretString: JSON.stringify({
                    username: binding.login,
                    password: mode === "readback" ? "different" : password,
                  }),
                };
              });
            const proveSecondary = vi.fn(
              async (client: pg.Client, scope: { organizationId: string; actorUserId: string }) => {
                expect(
                  (
                    await admin.query(
                      "SELECT credential_ready_at FROM platform.hotel_setup_creation_scopes WHERE database_login=$1",
                      [binding.login],
                    )
                  ).rows,
                ).toEqual([{ credential_ready_at: null }]);
                await secondary.checkHotelSetupCreationCredential(client, scope);
                if (mode === "proof") throw new Error("Synthetic rollback proof failure");
                if (mode === "authority")
                  await admin.query(
                    "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1 AND user_id=$2",
                    [binding.organizationId, binding.actorUserId],
                  );
                if (mode === "verifier")
                  await admin.query(
                    `ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(randomBytes(36).toString("base64url"))}`,
                  );
                if (mode === "assignment")
                  await admin.query(
                    "UPDATE platform.hotel_setup_creation_scopes SET organization_id=organization_id WHERE database_login=$1",
                    [binding.login],
                  );
              },
            );
            let readyUpdate = false;
            if (mode === "commitLost")
              vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
                this: pg.Client,
                ...args: unknown[]
              ) {
                const result = await (
                  originalQuery as unknown as (...values: unknown[]) => Promise<unknown>
                ).apply(this, args);
                if (
                  typeof args[0] === "string" &&
                  args[0].startsWith("UPDATE platform.hotel_setup_creation_scopes")
                )
                  readyUpdate = true;
                if (args[0] === "COMMIT" && readyUpdate) {
                  readyUpdate = false;
                  committedAckFault = true;
                  throw new Error("Synthetic lost COMMIT acknowledgement");
                }
                return result;
              } as never);
            const input = {
              adminDatabaseUrl: operationalUrl.toString(),
              nativeDatabaseUrl: native.toString(),
              databaseEndpoint: endpoint.toString(),
              inspectionReceipt: inspected,
              proveSecondary,
            };
            await expect(
              backfillApprovedHotelSetupOrganizationReadiness({
                ...input,
                inspectionReceipt: { ...inspected, expectedRoleOid: oid + 1 },
              }),
            ).rejects.toThrow("requires recovery inspection");
            expect(send).not.toHaveBeenCalled();
            if (mode === "success") {
              await admin.query("SELECT pg_catalog.pg_advisory_lock_shared(8734516)");
              try {
                await expect(
                  backfillApprovedHotelSetupOrganizationReadiness(input),
                ).rejects.toThrow("requires recovery inspection");
                const rejectedInsertGrants = (
                  await admin.query(
                    "SELECT column_name FROM information_schema.column_privileges WHERE grantee=$1 AND table_schema='identity' AND table_name='product_entitlements' AND privilege_type='INSERT'",
                    [binding.login],
                  )
                ).rows;
                expect(rejectedInsertGrants).toEqual([]);
              } finally {
                await admin.query("SELECT pg_catalog.pg_advisory_unlock_shared(8734516)");
              }
            }
            const run = backfillApprovedHotelSetupOrganizationReadiness(input);
            if (["success", "commitLost"].includes(mode))
              await expect(run).resolves.toMatchObject({
                status: mode === "success" ? "ready" : "ready_commit_inspected",
                roleOid: oid,
                secretVersion,
              });
            else await expect(run).rejects.toThrow("requires recovery inspection");
            expect(proveSecondary).toHaveBeenCalledOnce();
            const state = (
              await admin.query(
                "SELECT credential_role_oid,credential_secret_version,credential_ready_at FROM platform.hotel_setup_creation_scopes WHERE database_login=$1",
                [binding.login],
              )
            ).rows[0];
            expect(state).toEqual(
              ["success", "commitLost"].includes(mode)
                ? {
                    credential_role_oid: oid,
                    credential_secret_version: secretVersion,
                    credential_ready_at: expect.any(Date),
                  }
                : {
                    credential_role_oid: null,
                    credential_secret_version: null,
                    credential_ready_at: null,
                  },
            );
            const principal = (
              await admin.query(
                "SELECT oid,rolcanlogin,rolpassword FROM pg_authid WHERE rolname=$1",
                [binding.login],
              )
            ).rows[0];
            expect(principal.oid).toBe(oid);
            expect(principal.rolcanlogin).toBe(true);
            if (mode !== "verifier") expect(principal.rolpassword).toBe(verifier);
            const insertedColumns = (
              await admin.query(
                "SELECT column_name FROM information_schema.column_privileges WHERE grantee=$1 AND table_schema='identity' AND table_name='product_entitlements' AND privilege_type='INSERT' ORDER BY column_name",
                [binding.login],
              )
            ).rows;
            expect(insertedColumns.map((r) => r.column_name)).toEqual(
              [...HOTEL_SETUP_CREATION_PRIVILEGES["identity.product_entitlements"]!.INSERT!].sort(),
            );
            if (["success", "commitLost"].includes(mode)) {
              input.proveSecondary = vi.fn(secondary.checkHotelSetupCreationCredential);
              await expect(
                backfillApprovedHotelSetupOrganizationReadiness(input),
              ).resolves.toMatchObject({ status: "already_ready", roleOid: oid });
              await expect(
                backfillApprovedHotelSetupOrganizationReadiness({
                  ...input,
                  inspectionReceipt: { ...inspected, secretVersion: randomUUID() },
                }),
              ).rejects.toThrow("requires recovery inspection");
              expect(
                (
                  await admin.query(
                    "SELECT credential_ready_at FROM platform.hotel_setup_creation_scopes WHERE database_login=$1",
                    [binding.login],
                  )
                ).rows[0].credential_ready_at,
              ).toEqual(state.credential_ready_at);
            }
            vi.restoreAllMocks();
            await admin.query(
              "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 AND organization_id=$2",
              [binding.login, binding.organizationId],
            );
            await removeOwnedRole(binding.login);
            await admin.query(
              "UPDATE identity.organization_memberships SET status='active' WHERE organization_id=$1 AND user_id=$2",
              [binding.organizationId, binding.actorUserId],
            );
          }
        }
        expect(committedAckFault).toBe(true);
        expect(
          (
            await admin.query(
              "SELECT (SELECT count(*) FROM hotel_catalog.properties)::text AS properties,(SELECT count(*) FROM identity.product_entitlements)::text AS entitlements,(SELECT count(*) FROM platform.product_audit_events)::text AS audits",
            )
          ).rows,
        ).toEqual(before);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await admin.query("ROLLBACK");
        for (const binding of APPROVED_HOTEL_SETUP_BACKFILLS) {
          if (!createdOrganizations.has(binding.organizationId)) continue;
          await admin.query(
            "DELETE FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 AND organization_id=$2",
            [binding.login, binding.organizationId],
          );
          await removeOwnedRole(binding.login);
          await admin.query(
            "DELETE FROM identity.organization_memberships WHERE organization_id=$1 AND user_id=$2",
            [binding.organizationId, binding.actorUserId],
          );
          await admin.query("DELETE FROM identity.users WHERE id=$1", [binding.actorUserId]);
          await admin.query("DELETE FROM identity.organizations WHERE id=$1", [
            binding.organizationId,
          ]);
        }
        for (const login of [...owned.keys()]) await removeOwnedRole(login);
        for (const db of databases) {
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(db.name)} FROM PUBLIC`,
          );
          if (db.privileges.length)
            await admin.query(
              `GRANT ${db.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(db.name)} TO PUBLIC`,
            );
        }
        await admin.end();
      }
    }, 120_000);
  },
);
