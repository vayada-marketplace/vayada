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
import { HOTEL_SETUP_LOGO_PRIVILEGES } from "./hotelSetupLogoPrivileges.js";
import { createHotelSetupLogoCredentialResolver } from "./hotelSetupCommandCredentials.js";

vi.setConfig({ testTimeout: 30_000 });
const databaseUrl = process.env["TEST_DATABASE_URL"];
const creatorDatabaseUrl = process.env["VAY965_LOGO_CREATOR_DATABASE_URL"];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe.skipIf(!databaseUrl || !creatorDatabaseUrl)("protected logo credential lifecycle", () => {
  it.each([
    "success",
    "rollback",
    "stageCommit",
    "passwordBeforeReady",
    "assignment",
    "readyCommit",
  ])("native bootstrap: %s", async (mode) => {
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
    const creatorUrl = creatorDatabaseUrl!;
    if (creatorDatabaseUrl) {
      const creator = new URL(creatorDatabaseUrl);
      if (
        creator.hostname !== url.hostname ||
        creator.port !== url.port ||
        creator.pathname !== url.pathname ||
        creator.username !== "vayada_admin"
      )
        throw new Error("Owned local protected creator required");
      const creatorClient = new pg.Client({ connectionString: creatorUrl });
      await creatorClient.connect();
      try {
        expect(
          (
            await creatorClient.query(`SELECT rolsuper,rolcreaterole,
            pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_authid','SELECT') AS catalog_select,
            pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_authid','UPDATE') AS catalog_update
            FROM pg_catalog.pg_roles WHERE rolname=current_user`)
          ).rows,
        ).toEqual([
          { rolsuper: false, rolcreaterole: true, catalog_select: false, catalog_update: false },
        ]);
        await expect(
          creatorClient.query("SELECT oid FROM pg_catalog.pg_authid LIMIT 1"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await creatorClient.end();
      }
    }
    const organizationId = randomUUID(),
      actorUserId = randomUUID(),
      propertyId = randomUUID();
    const scope = {
      organizationId,
      actorUserId,
      propertyId,
      operation: "property_logo" as const,
    };
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
      const password = randomUUID() + randomUUID();
      const changedPassword = randomUUID() + randomUUID();
      const originalQuery = pg.Client.prototype.query;
      let pendingInserted = false,
        readyUpdated = false,
        faulted = false;
      const operations = {
        catalog: 0,
        creates: 0,
        roleChanges: 0,
        inserts: 0,
        readyUpdates: 0,
        destructive: 0,
      };
      const rotate = async () => {
        await admin.query(
          `ALTER ROLE ${admin.escapeIdentifier(login!)} PASSWORD ${admin.escapeLiteral(changedPassword)}`,
        );
      };
      vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const sql = typeof args[0] === "string" ? args[0] : "";
        const operational = (this as unknown as { user: string }).user === "vayada_admin";
        if (operational) {
          if (/\b(?:FROM|JOIN)\s+pg_catalog\.pg_authid\b/i.test(sql)) operations.catalog++;
          if (/^CREATE ROLE/.test(sql)) {
            operations.creates++;
            login = /^CREATE ROLE "([^"]+)"/.exec(sql)?.[1];
          }
          if (/ALTER ROLE/.test(sql)) operations.roleChanges++;
          if (
            /pg_terminate_backend|DROP ROLE|NOLOGIN PASSWORD NULL|DELETE FROM platform.hotel_setup_property_scopes/.test(
              sql,
            )
          )
            operations.destructive++;
        }
        const result = await (
          originalQuery as unknown as (...values: unknown[]) => Promise<unknown>
        ).apply(this, args);
        if (operational && /^INSERT INTO platform.hotel_setup_property_scopes/.test(sql.trim())) {
          operations.inserts++;
          pendingInserted = true;
          if (mode === "rollback") throw new Error("Synthetic failure after actual pending insert");
        }
        if (
          operational &&
          /^UPDATE platform.hotel_setup_property_scopes/.test(sql.trim()) &&
          /credential_ready_at/.test(sql)
        ) {
          operations.readyUpdates++;
          readyUpdated = true;
        }
        // Fault only after PostgreSQL has really committed, never a mocked COMMIT.
        if (
          operational &&
          sql === "COMMIT" &&
          !faulted &&
          ((pendingInserted && mode === "stageCommit") || (readyUpdated && mode === "readyCommit"))
        ) {
          faulted = true;
          throw new Error("Synthetic lost COMMIT acknowledgement");
        }
        return result;
      } as never);
      const stage = () =>
        stageHotelSetupPropertyRole({
          adminDatabaseUrl: creatorUrl,
          databaseEndpoint: endpoint.toString(),
          scope,
          logoPassword: password,
        });
      const assignment = async () =>
        (
          await admin.query(
            `SELECT database_login,actor_user_id,property_id,organization_id,active,xmin::text AS xid,
          credential_role_oid,credential_secret_version,credential_ready_at
          FROM platform.hotel_setup_property_scopes WHERE database_login=$1`,
            [login],
          )
        ).rows;
      const principal = async () =>
        (
          await admin.query(
            "SELECT oid,rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE rolname=$1",
            [login],
          )
        ).rows;
      if (["rollback", "stageCommit"].includes(mode)) {
        await expect(stage()).rejects.toThrow();
        expect(login).toMatch(/^vayada_next_hotel_setup_logo_/);
        expect(operations).toMatchObject({
          catalog: 0,
          creates: 1,
          roleChanges: 1,
          inserts: 1,
          destructive: 0,
          readyUpdates: 0,
        });
        if (mode === "rollback") {
          expect(await principal()).toEqual([]);
          expect(await assignment()).toEqual([]);
          login = undefined;
        } else {
          expect(faulted).toBe(true);
          const roles = await principal();
          expect(roles).toHaveLength(1);
          expect(roles[0]).toMatchObject({ rolcanlogin: true });
          expect(await assignment()).toEqual([
            expect.objectContaining({
              database_login: login,
              actor_user_id: actorUserId,
              property_id: propertyId,
              organization_id: organizationId,
              active: true,
              credential_ready_at: null,
              credential_role_oid: null,
              credential_secret_version: null,
            }),
          ]);
          const pendingUrl = new URL(url);
          pendingUrl.username = login!;
          pendingUrl.password = password;
          native = new pg.Client({ connectionString: pendingUrl.toString() });
          await native.connect();
          await expect(checkHotelSetupPropertyCredential(native, scope)).rejects.toThrow(
            "scope preflight failed",
          );
        }
        return;
      }
      const staged = await stage();
      login = staged.login;
      expect(staged.assignmentXid).toMatch(/^[0-9]+$/);
      const stagedPrincipal = (await principal())[0];
      expect(stagedPrincipal).toMatchObject({ oid: staged.roleOid, rolcanlogin: true });
      expect(stagedPrincipal.rolpassword).toMatch(/^SCRAM-SHA-256/);
      expect(await assignment()).toEqual([
        expect.objectContaining({
          database_login: login,
          actor_user_id: actorUserId,
          property_id: propertyId,
          organization_id: organizationId,
          active: true,
          xid: staged.assignmentXid,
          credential_role_oid: null,
          credential_secret_version: null,
          credential_ready_at: null,
        }),
      ]);
      if (creatorDatabaseUrl) {
        expect(
          (
            await admin.query(
              `SELECT member.rolname,edge.admin_option,edge.inherit_option,edge.set_option,
             grantor.rolsuper AS grantor_superuser
           FROM pg_catalog.pg_auth_members edge
           JOIN pg_catalog.pg_roles member ON member.oid=edge.member
           JOIN pg_catalog.pg_roles grantor ON grantor.oid=edge.grantor
           WHERE edge.roleid=$1::oid`,
              [staged.roleOid],
            )
          ).rows,
        ).toEqual([
          {
            rolname: "vayada_admin",
            admin_option: true,
            inherit_option: false,
            set_option: false,
            grantor_superuser: true,
          },
        ]);
      }
      const nativeUrl = new URL(url);
      nativeUrl.username = login;
      nativeUrl.password = password;
      vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
      vi.stubEnv("AWS_PROFILE", undefined);
      vi.spyOn(STSClient.prototype, "send").mockResolvedValue({
        Account: "269416271598",
      } as never);
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
        if (mode === "passwordBeforeReady") await rotate();
        if (mode === "assignment")
          await admin.query(
            "UPDATE platform.hotel_setup_property_scopes SET active=active WHERE database_login=$1",
            [login],
          );
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
      const activation = activateVerifiedHotelSetupPropertyRole({
        staged,
        adminDatabaseUrl: creatorUrl,
        databaseEndpoint: endpoint.toString(),
        nativeDatabaseUrl: nativeUrl.toString(),
        proveSecondary,
        publish: true,
      }).catch((error) => {
        throw secondaryFailure ?? error;
      });
      if (mode !== "success") {
        await expect(activation).rejects.toThrow();
        const state = await assignment();
        expect(state).toHaveLength(1);
        const committedReady = mode === "readyCommit";
        expect(state[0]).toMatchObject({
          active: true,
          credential_role_oid: committedReady ? staged.roleOid : null,
          credential_secret_version: committedReady ? versionId : null,
          credential_ready_at: committedReady ? expect.any(Date) : null,
        });
        if (committedReady) expect(faulted).toBe(true);
        const role = (await principal())[0];
        expect(role).toMatchObject({ oid: staged.roleOid, rolcanlogin: true });
        const changed = mode === "passwordBeforeReady";
        if (!changed) expect(role.rolpassword).toBe(stagedPrincipal.rolpassword);
        else expect(role.rolpassword).not.toBe(stagedPrincipal.rolpassword);
        const currentUrl = new URL(nativeUrl);
        if (changed) currentUrl.password = changedPassword;
        native = new pg.Client({ connectionString: currentUrl.toString() });
        await native.connect();
        if (!committedReady) {
          await expect(checkHotelSetupPropertyCredential(native, scope)).rejects.toThrow(
            "scope preflight failed",
          );
          await expect(resolve(propertyId, organizationId, actorUserId)).rejects.toThrow(
            "Missing hotel setup logo assignment",
          );
        }
        expect(operations).toMatchObject({
          catalog: 0,
          creates: 1,
          roleChanges: 1,
          inserts: 1,
          destructive: 0,
          readyUpdates: committedReady ? 1 : 0,
        });
        expect(
          send.mock.calls.filter(([command]) => command instanceof CreateSecretCommand),
        ).toHaveLength(1);
        return;
      }
      const activated = await activation;
      expect(proveSecondary).toHaveBeenCalled();
      expect(operations).toMatchObject({
        catalog: 0,
        creates: 1,
        roleChanges: 1,
        inserts: 1,
        destructive: 0,
        readyUpdates: 1,
      });
      expect(
        send.mock.calls.filter(([command]) => command instanceof CreateSecretCommand),
      ).toHaveLength(1);
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
      vi.restoreAllMocks();
      await native?.end();
      if (login && creatorDatabaseUrl) {
        const creator = new pg.Client({ connectionString: creatorDatabaseUrl });
        await creator.connect();
        try {
          await creator.query(
            `REVOKE DELETE ON hotel_catalog.property_media FROM ${creator.escapeIdentifier(login)}`,
          );
          await creator.query(
            `REVOKE USAGE ON SCHEMA identity,hotel_catalog,platform FROM ${creator.escapeIdentifier(login)}`,
          );
          await creator.query(
            `REVOKE CONNECT ON DATABASE ${creator.escapeIdentifier(decodeURIComponent(url.pathname.slice(1)))} FROM ${creator.escapeIdentifier(login)}`,
          );
          // Revoke column ACLs using their original grantor before dropping the fixture role.
          for (const [relation, grants] of Object.entries(HOTEL_SETUP_LOGO_PRIVILEGES))
            for (const [privilege, columns] of Object.entries(grants))
              await creator.query(
                `REVOKE ${privilege}(${columns.join(",")}) ON ${relation} FROM ${creator.escapeIdentifier(login)} CASCADE`,
              );
        } finally {
          await creator.end();
        }
      }
      for (const database of databaseAcls)
        await admin.query("UPDATE pg_database SET datacl=$1::aclitem[] WHERE datname=$2", [
          database.acl,
          database.name,
        ]);
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
  });
});
