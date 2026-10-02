import { randomUUID } from "node:crypto";
import { AuthorizationResolutionError, type RequestContext } from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  assertHotelSetupReaderPrivileges,
  HOTEL_SETUP_READER_AUDIT_COLUMNS,
  HOTEL_SETUP_READER_READ_COLUMNS,
  HOTEL_SETUP_CREATION_READER_READ_COLUMNS,
} from "./hotelSetupReaderPrivileges.js";

const modes = ["property_commands", "property_creation"] as const;
const connectionString = process.env.HOTEL_SETUP_READER_TEST_DATABASE_URL;
describe.runIf(connectionString)("private reader rejection-audit boundary", () => {
  it.each(modes)("rejection audit: %s", async (mode) => {
    if (
      !connectionString ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)
    )
      throw new Error("Hotel setup reader fixture requires a disposable local database");
    const client = new pg.Client({ connectionString });
    await client.connect();
    const reader =
      mode === "property_creation"
        ? "vayada_next_hotel_setup_creation_reader"
        : "vayada_next_hotel_setup_reader";
    const organizations = [randomUUID(), randomUUID()];
    const users = [randomUUID(), randomUUID()];
    const memberships = [randomUUID(), randomUUID()];
    // Real canonical repository SQL runs on this real reader session, in one rollback fixture.
    const query = vi
      .spyOn(pg.Pool.prototype, "query")
      .mockImplementation(client.query.bind(client) as pg.Pool["query"]);
    const propertyAccess = createPgPropertyAccessRepository({ connectionString });
    const roles = createPgRolePermissionRepository({ connectionString });
    const context: RequestContext = {
      actor: {
        internalUserId: users[0]!,
        providerIdentity: { provider: "workos", providerUserId: "test" },
        email: "reader@example.test",
        status: "active",
      },
      selectedOrganization: {
        organizationId: organizations[0]!,
        workosOrgId: "test",
        kind: "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: memberships[0]!,
        roleKey: "front_desk",
        status: "active",
        workosRoleSlugs: [],
        permissions: [],
      },
      linkedResources: [],
      entitlements: [],
      locale: "en-US",
      currency: "EUR",
      audit: { requestId: randomUUID(), receivedAt: new Date().toISOString(), source: "api" },
    };
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${reader} LOGIN NOINHERIT`);
      await client.query(`GRANT USAGE ON SCHEMA identity,platform TO ${reader}`);
      for (const [relation, columns] of Object.entries(
        mode === "property_creation"
          ? HOTEL_SETUP_CREATION_READER_READ_COLUMNS
          : HOTEL_SETUP_READER_READ_COLUMNS,
      ))
        await client.query(`GRANT SELECT (${columns.join(",")}) ON ${relation} TO ${reader}`);
      await client.query(
        `GRANT INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")}) ON platform.product_audit_events TO ${reader}`,
      );
      for (let index = 0; index < 2; index++) {
        await client.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES ($1::uuid,'hotel_group','Reader audit test',$1::text)",
          [organizations[index]],
        );
        await client.query(
          "INSERT INTO identity.users(id,email,name) VALUES ($1,$2,'Reader audit test')",
          [users[index], `${users[index]}@example.test`],
        );
        await client.query(
          `INSERT INTO identity.organization_memberships
          (id,user_id,organization_id,role_key,property_access_mode,access_origin,permission_overrides)
          VALUES ($1,$2,$3,'front_desk','all','agency','{"grant":["not_a_permission"],"deny":[]}')`,
          [memberships[index], users[index], organizations[index]],
        );
      }
      const businessSnapshot = async () =>
        (
          await client.query(`SELECT
        (SELECT pg_catalog.jsonb_agg(e ORDER BY e.id) FROM identity.product_entitlements e) AS entitlements,
        (SELECT count(*) FROM pms.property_pricing_settings) AS pricing,
        (SELECT count(*) FROM finance.expense_categories) AS categories`)
        ).rows;
      const before = await businessSnapshot();
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      await assertHotelSetupReaderPrivileges(client, mode);
      const resolve = createAuthorizationResolver(roles, undefined, propertyAccess);
      await expect(resolve(context)).rejects.toBeInstanceOf(AuthorizationResolutionError);
      await expect(resolve(context)).rejects.toBeInstanceOf(AuthorizationResolutionError);
      // Only matching rejection keys are visible for canonical conflict retries.
      expect(
        (await client.query("SELECT product,audit_key FROM platform.product_audit_events")).rows,
      ).toEqual([
        {
          product: "identity",
          audit_key: `staff.permission_override.rejected:${context.audit.requestId}`,
        },
      ]);
      await client.query("RESET SESSION AUTHORIZATION");
      const result = await client.query(
        "SELECT * FROM platform.product_audit_events WHERE organization_id=$1",
        [organizations[0]],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toMatchObject({
        action: "identity.staff.permission_override.rejected",
        actor_user_id: users[0],
        target_resource_id: memberships[0],
        retention_class: "security",
        privacy_scope: "confidential",
        private_payload: {},
        redacted_payload: {
          outcome: "denied",
          code: "invalid_permission_override",
          issueCodes: ["unknown_permission_key"],
        },
      });

      const row: Record<string, unknown> = Object.fromEntries(
        HOTEL_SETUP_READER_AUDIT_COLUMNS.map((column) => [column, result.rows[0][column]]),
      );
      const mutations = [
        { action: "financials_module_activated", product: "pms" },
        { action: "identity.staff.changed" },
        { organization_id: organizations[1] },
        { actor_user_id: users[1] },
        { target_resource_id: memberships[1] },
        { target_resource_type: "user" },
        { retention_class: "financial" },
        { privacy_scope: "internal" },
        {
          redacted_payload: {
            outcome: "allowed",
            code: "invalid_permission_override",
            issueCodes: ["unknown_permission_key"],
          },
        },
        {
          redacted_payload: {
            outcome: "denied",
            code: "invalid_permission_override",
            issueCodes: [],
          },
        },
        {
          redacted_payload: {
            outcome: "denied",
            code: "invalid_permission_override",
            issueCodes: "secret",
          },
        },
        {
          redacted_payload: {
            outcome: "denied",
            code: "invalid_permission_override",
            issueCodes: ["secret"],
          },
        },
        { audit_metadata: { requestId: "test", source: "api", private: "secret" } },
        { audit_key: "wrong-prefix" },
        { private_payload: { secret: "private" } },
      ];
      for (const mutation of mutations) {
        await client.query("SAVEPOINT denial");
        await client.query(`SET SESSION AUTHORIZATION ${reader}`);
        const candidate = { ...row, ...mutation };
        const columns = Object.keys(candidate);
        await expect(
          client.query(
            `INSERT INTO platform.product_audit_events (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            Object.values(candidate),
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT denial");
        await client.query("RESET SESSION AUTHORIZATION");
      }
      for (const sql of [
        `UPDATE identity.organization_memberships SET status='suspended' WHERE id='${memberships[0]}'`,
        `UPDATE identity.users SET status='suspended' WHERE id='${users[0]}'`,
        `UPDATE identity.organizations SET status='suspended' WHERE id='${organizations[0]}'`,
      ]) {
        await client.query("SAVEPOINT inactive");
        await client.query(sql);
        await client.query(`SET SESSION AUTHORIZATION ${reader}`);
        await expect(
          propertyAccess.recordInvalidPermissionOverride!(context, ["unknown_permission_key"]),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT inactive");
        await client.query("RESET SESSION AUTHORIZATION");
      }
      for (const sql of [
        "ALTER TABLE platform.product_audit_events DISABLE ROW LEVEL SECURITY",
        "ALTER POLICY hotel_setup_reader_rejection_audit ON platform.product_audit_events WITH CHECK (true)",
        "DROP POLICY hotel_setup_reader_rejection_audit ON platform.product_audit_events",
        "DROP POLICY identity_runtime_scope ON platform.product_audit_events",
        "CREATE POLICY vay1092_extra_restrictive_audit ON platform.product_audit_events AS RESTRICTIVE FOR INSERT WITH CHECK (false)",
        "ALTER FUNCTION platform.hotel_setup_reader_audit_allowed(platform.product_audit_events) SET search_path=public",
        "REVOKE EXECUTE ON FUNCTION platform.hotel_setup_reader_audit_allowed(platform.product_audit_events) FROM PUBLIC",
        "CREATE OR REPLACE FUNCTION platform.hotel_setup_reader_audit_allowed(candidate platform.product_audit_events) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN true; END'",
        "ALTER TABLE platform.product_audit_events DISABLE TRIGGER hotel_setup_feature_hub_apply",
        `CREATE FUNCTION platform.vay1092_reader_audit_probe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN NEW; END'; REVOKE ALL ON FUNCTION platform.vay1092_reader_audit_probe() FROM PUBLIC; CREATE TRIGGER vay1092_reader_audit_probe AFTER INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION platform.vay1092_reader_audit_probe()`,
      ]) {
        await client.query("SAVEPOINT drift");
        await client.query(sql);
        await client.query(`SET SESSION AUTHORIZATION ${reader}`);
        await expect(assertHotelSetupReaderPrivileges(client, mode)).rejects.toThrow(
          "audit boundary mismatch",
        );
        await client.query("RESET SESSION AUTHORIZATION");
        await client.query("ROLLBACK TO SAVEPOINT drift");
      }
      await client.query("SAVEPOINT write_drift");
      await client.query(
        `GRANT UPDATE (audit_key),DELETE ON platform.product_audit_events TO ${reader}`,
      );
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      expect(
        (await client.query("UPDATE platform.product_audit_events SET audit_key='changed'"))
          .rowCount,
      ).toBe(0);
      expect((await client.query("DELETE FROM platform.product_audit_events")).rowCount).toBe(0);
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query("ROLLBACK TO SAVEPOINT write_drift");
      await client.query("SAVEPOINT missing_audit");
      await client.query(
        `REVOKE INSERT (${HOTEL_SETUP_READER_AUDIT_COLUMNS.join(",")}) ON platform.product_audit_events FROM ${reader}`,
      );
      await client.query(`SET SESSION AUTHORIZATION ${reader}`);
      await expect(resolve(context)).rejects.toThrow("Permission override audit is unavailable");
      await client.query("ROLLBACK TO SAVEPOINT missing_audit");
      await client.query("RESET SESSION AUTHORIZATION");
      expect(await businessSnapshot()).toEqual(before);
      // Existing non-reader callers keep their existing audit behavior.
      await client.query("SAVEPOINT existing");
      await client.query("CREATE ROLE vay1092_existing_audit_caller NOLOGIN");
      await client.query(
        "GRANT USAGE ON SCHEMA platform TO vay1092_existing_audit_caller; GRANT INSERT ON platform.product_audit_events TO vay1092_existing_audit_caller",
      );
      await client.query("SET SESSION AUTHORIZATION vay1092_existing_audit_caller");
      await client.query(
        `INSERT INTO platform.product_audit_events (audit_key,product,action,occurred_at,tenant_scope,target_resource_product,target_resource_type,target_resource_id) VALUES ('existing-caller','platform','existing-caller',now(),'platform','platform','test','test')`,
      );
      await client.query("RESET SESSION AUTHORIZATION");
      await client.query(
        `GRANT ${reader} TO vay1092_existing_audit_caller WITH INHERIT FALSE, SET TRUE`,
      );
      await client.query("SET SESSION AUTHORIZATION vay1092_existing_audit_caller");
      await client.query(`SET ROLE ${reader}`);
      await expect(
        propertyAccess.recordInvalidPermissionOverride!(context, ["unknown_permission_key"]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT existing");
      await client.query("RESET ROLE");
      await client.query("RESET SESSION AUTHORIZATION");
    } finally {
      query.mockRestore();
      await propertyAccess.close?.();
      await roles.close?.();
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }
  });
});
