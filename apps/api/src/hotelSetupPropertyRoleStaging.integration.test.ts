import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";
import type { HotelSetupOperation } from "./hotelSetupCommandScope.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES } from "./hotelSetupLaunchSettingsPrivileges.js";

const connectionString = process.env.HOTEL_SETUP_PROPERTY_STAGE_TEST_DATABASE_URL;
describe.runIf(connectionString)("manual disabled property-role staging", () => {
  it("pins each purpose, rejects stale authority/assignments and rolls back failed grants", async () => {
    const url = new URL(connectionString!);
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/vay1092_"))
      throw new Error("Owned local test cluster required");
    const endpoint = new URL(url);
    endpoint.username = endpoint.password = endpoint.search = "";
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const databases = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type) FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    const organizationId = randomUUID(),
      actorUserId = randomUUID(),
      propertyId = randomUUID();
    const other = randomUUID(),
      roleKey = `stage_${randomBytes(12).toString("hex")}`;
    const roles: string[] = [];
    const scope = {
      propertyId,
      organizationId,
      actorUserId,
      operation: "launch_settings" as HotelSetupOperation,
    };
    const input = {
      adminDatabaseUrl: connectionString!,
      databaseEndpoint: endpoint.toString(),
      scope,
    };
    const provisioner = `vay1092_stage_${randomBytes(12).toString("hex")}`;
    const count = async () =>
      (
        await admin.query(
          "SELECT count(*)::text AS count FROM pg_catalog.pg_roles WHERE rolname LIKE 'vayada_next_hotel_setup_property_%'",
        )
      ).rows;
    const counts = async () =>
      (
        await admin.query(`SELECT
      (SELECT count(*) FROM finance.expense_categories)::text AS categories,
      (SELECT count(*) FROM pms.property_pricing_settings)::text AS pricing,
      (SELECT count(*) FROM identity.product_entitlements)::text AS entitlements,
      (SELECT count(*) FROM platform.product_audit_events)::text AS audits`)
      ).rows;
    try {
      for (const database of databases)
        await admin.query(
          `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
        );
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','staging fixture',$2)",
        [organizationId, roleKey],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        actorUserId,
        `${roleKey}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled)
        VALUES($1,$2,$3,'agency','all',FALSE)`,
        [organizationId, actorUserId, roleKey],
      );
      for (const permission of [
        "hotel_catalog.setup.manage",
        "pms.operations.manage",
        "pms.finance.manage",
      ])
        await admin.query(
          "INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,$2)",
          [roleKey, permission],
        );
      for (const id of [propertyId, other]) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'staging fixture',$2)",
          [id, organizationId],
        );
        await admin.query(
          `INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status)
          VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')`,
          [organizationId, id],
        );
      }
      await admin.query(
        "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')",
        [organizationId],
      );
      const before = await counts();
      for (const operation of [
        "launch_settings",
        "currency",
        "currency_ready",
        "feature_hub",
      ] as const) {
        scope.operation = operation;
        // Marketplace-only setup can stage launch settings, but no PMS-purpose login.
        if (operation !== "launch_settings") {
          await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow("staging failed");
          await admin.query(
            "UPDATE identity.organization_memberships SET pms_access_enabled=TRUE WHERE user_id=$1",
            [actorUserId],
          );
        }
        const staged = await stageHotelSetupPropertyRole({
          ...input,
          scope: { ...scope, login: "admin", roleOid: 0 },
        } as typeof input);
        roles.push(staged.login);
        await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow("staging failed");
        const role = admin.escapeIdentifier(staged.login);
        expect(
          (
            await admin.query(
              `SELECT rolcanlogin,rolpassword,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_catalog.pg_authid WHERE oid=$1`,
              [staged.roleOid],
            )
          ).rows,
        ).toEqual([
          {
            rolcanlogin: false,
            rolpassword: null,
            rolinherit: false,
            rolsuper: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ]);
        expect(
          (
            await admin.query(
              "SELECT * FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
              [staged.login],
            )
          ).rows,
        ).toEqual([]);
        const nativeUrl = new URL(url);
        nativeUrl.username = staged.login;
        nativeUrl.password = randomBytes(36).toString("base64url");
        await admin.query(
          `ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(decodeURIComponent(nativeUrl.password))}`,
        );
        const disabled = new pg.Client({ connectionString: nativeUrl.toString() });
        try {
          await expect(disabled.connect()).rejects.toMatchObject({ code: "28000" });
        } finally {
          await disabled.end();
        }
        // Fixture-only activation/assignment to prove the staged effective grants natively.
        await admin.query(`ALTER ROLE ${role} LOGIN`);
        await admin.query(
          "INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class) VALUES($1,$2,$3,$4)",
          [staged.login, propertyId, organizationId, operation],
        );
        const native = new pg.Client({ connectionString: nativeUrl.toString() });
        await native.connect();
        try {
          await expect(checkHotelSetupPropertyCredential(native, scope)).resolves.toBeUndefined();
          await expect(
            checkHotelSetupPropertyCredential(native, { ...scope, propertyId: other }),
          ).rejects.toThrow("scope preflight failed");
          await expect(
            checkHotelSetupPropertyCredential(native, {
              ...scope,
              operation: operation === "launch_settings" ? "currency_ready" : "launch_settings",
            }),
          ).rejects.toThrow();
          await expect(
            native.query("SELECT private_payload FROM platform.product_audit_events"),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await native.end();
        }
        await admin.query(
          "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
          [staged.login],
        );
        const existing = await count();
        await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow("staging failed");
        expect(await count()).toEqual(existing);
        await admin.query(
          "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
          [staged.login],
        );
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
        roles.pop();
        await admin.query(
          "UPDATE identity.organization_memberships SET pms_access_enabled=FALSE WHERE user_id=$1",
          [actorUserId],
        );
      }
      scope.operation = "launch_settings";
      const original = await count();
      for (const changed of [
        { ...scope, organizationId: randomUUID() },
        { ...scope, actorUserId: randomUUID() },
        { ...scope, propertyId: randomUUID() },
        { ...scope, operation: "__proto__" as HotelSetupOperation },
      ])
        await expect(stageHotelSetupPropertyRole({ ...input, scope: changed })).rejects.toThrow(
          "staging failed",
        );
      await admin.query(
        "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$1 AND product='pms'",
        [organizationId],
      );
      await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow("staging failed");
      await admin.query(
        "UPDATE identity.organization_resource_links SET status='active' WHERE organization_id=$1",
        [organizationId],
      );
      await admin.query(
        "UPDATE identity.organization_memberships SET status='suspended' WHERE user_id=$1",
        [actorUserId],
      );
      await expect(stageHotelSetupPropertyRole(input)).rejects.toThrow("staging failed");
      await admin.query(
        "UPDATE identity.organization_memberships SET status='active' WHERE user_id=$1",
        [actorUserId],
      );
      expect(await count()).toEqual(original);

      // Restricted fixture provisioner can stage all reads but lacks final audit INSERT grant authority.
      await admin.query(
        `CREATE ROLE ${provisioner} LOGIN CREATEROLE BYPASSRLS PASSWORD ${admin.escapeLiteral(randomBytes(36).toString("base64url"))}`,
      );
      roles.push(provisioner);
      const password = randomBytes(36).toString("base64url");
      await admin.query(`ALTER ROLE ${provisioner} PASSWORD ${admin.escapeLiteral(password)}`);
      await admin.query(
        `GRANT vayada_next_hotel_setup_property_scope TO ${provisioner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${admin.escapeIdentifier(url.pathname.slice(1))} TO ${provisioner} WITH GRANT OPTION`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA identity,platform,hotel_catalog,booking TO ${provisioner} WITH GRANT OPTION`,
      );
      for (const [table, privileges] of Object.entries(HOTEL_SETUP_LAUNCH_SETTINGS_PRIVILEGES))
        for (const [privilege, columns] of Object.entries(privileges))
          if (!(table === "platform.product_audit_events" && privilege === "INSERT"))
            await admin.query(
              `GRANT ${privilege}(${columns.join(",")}) ON ${table} TO ${provisioner} WITH GRANT OPTION`,
            );
      await admin.query(
        `GRANT DELETE ON hotel_catalog.property_contact_channels TO ${provisioner} WITH GRANT OPTION`,
      );
      await admin.query(
        `GRANT SELECT,UPDATE ON identity.organizations,identity.organization_resource_links,platform.hotel_setup_property_scopes TO ${provisioner}`,
      );
      const restricted = new URL(url);
      restricted.username = provisioner;
      restricted.password = password;
      const queries = vi.spyOn(pg.Client.prototype, "query");
      try {
        await expect(
          stageHotelSetupPropertyRole({ ...input, adminDatabaseUrl: restricted.toString() }),
        ).rejects.toThrow("staging failed");
        expect(
          queries.mock.calls.some(
            ([sql]) => typeof sql === "string" && sql.startsWith("CREATE ROLE"),
          ),
        ).toBe(true);
        expect(
          queries.mock.calls.some(
            ([sql]) =>
              typeof sql === "string" &&
              sql.startsWith("GRANT INSERT") &&
              sql.includes("platform.product_audit_events"),
          ),
        ).toBe(true);
      } finally {
        queries.mockRestore();
      }
      expect(await count()).toEqual(original);
      expect(await counts()).toEqual(before);
    } finally {
      await admin.query("ROLLBACK");
      for (const login of roles.reverse()) {
        await admin.query(
          "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
          [login],
        );
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(login)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(login)}`);
      }
      for (const database of databases)
        if (database.privileges.length)
          await admin.query(
            `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
          );
      await admin.end();
    }
  }, 90_000);
});
