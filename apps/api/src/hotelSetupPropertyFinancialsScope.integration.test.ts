import { runHotelSetupPreflight } from "./cli/hotelSetupPreflight.testHelper.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import {
  assertHotelSetupFeatureHubPrivileges,
  HOTEL_SETUP_FEATURE_HUB_PRIVILEGES,
} from "./hotelSetupFeatureHubPrivileges.js";
import {
  assertHotelSetupCurrencyPrivileges,
  HOTEL_SETUP_CURRENCY_PRIVILEGES,
  HOTEL_SETUP_CURRENCY_READY_PRIVILEGES,
} from "./hotelSetupCurrencyPrivileges.js";
import { createPgHotelSetupFeatureHubRepository } from "./hotelSetupFeatureHubRepository.js";

import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { seedPendingHotelFinancialsCategories } from "./domains/financeStarterCategories.js";
import {
  beginHotelSetupCommandScope,
  withHotelSetupCommandScope,
} from "./hotelSetupCommandScope.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";

const url = process.env["TEST_DATABASE_URL"];

async function expectBlocked(observer: pg.Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await observer.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected transaction to wait on a lock");
}

describe.skipIf(!url)("hotel setup property Financials scope", () => {
  it("isolates two hotels in one organization and revokes an already connected login", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");

    const admin = new pg.Client({ connectionString: url });
    const inspector = new pg.Client({ connectionString: url });
    const suffix = randomUUID().replaceAll("-", "");
    const ownedRelation = `hotel_setup_scope_owned_${suffix}`;
    const roles = [0, 1, 2, 3, 4, 5].map((index) =>
      index === 5
        ? `vayada_test_lock_reader_${suffix}`
        : `vayada_next_hotel_setup_property_${index}_${suffix.slice(0, 24)}`,
    );
    const passwords = roles.map(() => randomUUID());
    const organizations = [randomUUID(), randomUUID()];
    const organizationId = organizations[0]!;
    const users = [randomUUID(), randomUUID()];
    const roleKeys = [`lock_owner_${suffix}`, `lock_other_${suffix}`];
    const roleDefinition = randomUUID();
    const properties = [randomUUID(), randomUUID()];
    const fixtureRelations = [
      "hotel_catalog.properties",
      "identity.organization_resource_links",
      "identity.product_entitlements",
      "identity.organizations",
      "identity.users",
      "identity.organization_memberships",
      "identity.role_permission_grants",
      "identity.organization_roles",
      "identity.membership_property_assignments",
      "pms.property_pricing_settings",
      "pms.room_types",
      "pms.rate_plans",
      "pms.rate_rules",
      "pms.recurring_pricing_sources",
      "finance.expense_categories",
      "platform.idempotency_keys",
      "platform.domain_events",
      "platform.outbox_events",
      "platform.product_audit_events",
    ];
    const logins: pg.Client[] = [];
    const scopePool = (login: pg.Client) => ({
      async end() {},
      async connect() {
        return {
          async query<T>(sql: string, values?: readonly unknown[]) {
            const result = await login.query(sql, values ? [...values] : []);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          },
          release() {},
        };
      },
    });
    async function credentialPreflight(operation: "currency" | "currency_ready" | "feature_hub") {
      const databaseUrl = new URL(url!);
      if (databaseUrl.hostname !== "127.0.0.1" || !databaseUrl.pathname.startsWith("/vay1092_"))
        throw new Error("Native preflight needs an isolated local migrated database");
      const databases = (
        await admin.query<{ name: string; privileges: string[] }>(`
        SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type) FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
        FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
        WHERE d.datallowconn GROUP BY d.datname`)
      ).rows;
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const counts = () =>
        admin.query(
          "SELECT (SELECT count(*) FROM platform.product_audit_events)::text AS audits, (SELECT count(*) FROM pms.property_pricing_settings)::text AS pricing, (SELECT count(*) FROM finance.expense_categories)::text AS categories",
        );
      const before = (await counts()).rows;
      const scope = { organizationId, propertyId: properties[1]!, operation };
      try {
        for (const database of databases)
          await admin.query(`REVOKE ALL ON DATABASE ${quote(database.name)} FROM PUBLIC`);
        await admin.query(
          `GRANT CONNECT ON DATABASE ${quote(new URL(url!).pathname.slice(1))} TO ${roles[1]}`,
        );
        await admin.query(
          `GRANT CONNECT ON DATABASE ${quote(databaseUrl.pathname.slice(1))} TO ${roles[1]} WITH GRANT OPTION`,
        );
        await expect(checkHotelSetupPropertyCredential(logins[1]!, scope)).rejects.toThrow(
          "database isolation",
        );
        await admin.query(
          `REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${quote(databaseUrl.pathname.slice(1))} FROM ${roles[1]}`,
        );
        await checkHotelSetupPropertyCredential(logins[1]!, scope);
        await expect(
          checkHotelSetupPropertyCredential(logins[1]!, { ...scope, propertyId: properties[0]! }),
        ).rejects.toThrow();
        await expect(
          checkHotelSetupPropertyCredential(logins[1]!, {
            ...scope,
            organizationId: organizations[1]!,
          }),
        ).rejects.toThrow();
        if (process.env.NODE_EXTRA_CA_CERTS) {
          const credential = new URL(url!);
          credential.username = roles[1]!;
          credential.password = passwords[1]!;
          credential.search = "?sslmode=verify-full";
          const endpoint = new URL(url!);
          endpoint.username = endpoint.password = endpoint.search = "";
          const run = (overrides: NodeJS.ProcessEnv = {}) =>
            runHotelSetupPreflight("hotelSetupPropertyPreflight", {
              HOTEL_SETUP_COMMAND_DATABASE_URL: credential.toString(),
              HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: endpoint.toString(),
              HOTEL_SETUP_COMMAND_DATABASE_LOGIN: roles[1],
              HOTEL_SETUP_COMMAND_PROPERTY_ID: properties[1],
              HOTEL_SETUP_COMMAND_ORGANIZATION_ID: organizationId,
              HOTEL_SETUP_COMMAND_OPERATION: operation,
              PGHOST: "untrusted.invalid",
              PGPORT: "1",
              PGOPTIONS: "-c role=postgres",
              ...overrides,
            });
          expect(run()).toMatchObject({
            status: 0,
            stderr: "",
            stdout: '{"status":"PASS","scope":"hotel_setup_property"}\n',
          });
          const bad = new URL(credential);
          bad.password = "wrong-password".repeat(4);
          const failure = {
            status: 1,
            stdout: "",
            stderr: '{"status":"FAIL","code":"hotel_setup_property_preflight_failed"}\n',
          };
          for (const overrides of [
            { NODE_EXTRA_CA_CERTS: "" },
            { HOTEL_SETUP_COMMAND_DATABASE_URL: bad.toString() },
            { HOTEL_SETUP_COMMAND_PROPERTY_ID: properties[0] },
            { HOTEL_SETUP_COMMAND_ORGANIZATION_ID: organizations[1] },
            {
              HOTEL_SETUP_COMMAND_OPERATION:
                operation === "currency" ? "currency_ready" : "currency",
            },
          ])
            expect(run(overrides)).toMatchObject(failure);
          await admin.query(
            `GRANT CONNECT ON DATABASE ${quote(databaseUrl.pathname.slice(1))} TO ${roles[1]} WITH GRANT OPTION`,
          );
          expect(run()).toMatchObject(failure);
          await admin.query(
            `REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${quote(databaseUrl.pathname.slice(1))} FROM ${roles[1]}`,
          );
          await admin.query(
            `GRANT SELECT (private_payload) ON platform.product_audit_events TO ${roles[1]}`,
          );
          expect(run()).toMatchObject(failure);
          await admin.query(
            `REVOKE SELECT (private_payload) ON platform.product_audit_events FROM ${roles[1]}`,
          );
        }
        await admin.query(
          `GRANT TEMPORARY ON DATABASE ${quote(new URL(url!).pathname.slice(1))} TO PUBLIC`,
        );
        await expect(checkHotelSetupPropertyCredential(logins[1]!, scope)).rejects.toThrow(
          "database isolation",
        );
        expect((await counts()).rows).toEqual(before);
      } finally {
        for (const database of databases) {
          await admin.query(`REVOKE ALL ON DATABASE ${quote(database.name)} FROM PUBLIC`);
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${quote(database.name)} TO PUBLIC`,
            );
        }
      }
    }
    let transferOpen = false;
    let inspectorConnected = false;
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Property scope test', $3),
                ($2, 'hotel_group', 'Property scope receiver', $4)`,
        [
          organizationId,
          organizations[1],
          `property-scope-${suffix}`,
          `property-receiver-${suffix}`,
        ],
      );
      for (let index = 0; index < 6; index++) {
        const role = roles[index]!;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[index]}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await admin.query(
          `GRANT USAGE ON SCHEMA platform, identity, hotel_catalog, pms, finance TO ${role}`,
        );
        // Deliberately broad ACLs prove RLS, rather than missing grants, deny cross-hotel writes.
        for (const relation of fixtureRelations) {
          await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${relation} TO ${role}`);
        }
        if (index !== 5)
          await admin.query(
            `GRANT vayada_next_hotel_setup_property_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
          );
        if (index < 2) {
          const ownerResourceId =
            index === 0 ? properties[index]!.toUpperCase() : properties[index]!;
          await admin.query(
            `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Property scope hotel', $3)`,
            [properties[index], `property-scope-${index}-${suffix}`, organizationId],
          );
          await admin.query(
            `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active'),
                  ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
            [organizationId, ownerResourceId],
          );
          await admin.query(
            `INSERT INTO platform.hotel_setup_property_scopes
             (database_login, property_id, organization_id) VALUES ($1, $2, $3)`,
            [role, properties[index], organizationId],
          );
          await admin.query(
            `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, status,
              resource_product, resource_type, resource_id, metadata)
           VALUES ($1, 'pms', 'module:financials', 'suspended',
                   'pms', 'pms_property', $2, '{"newHotelFinancialsDefault":"pending"}')`,
            [organizationId, properties[index]],
          );
        }
        if (index >= 3 && index < 5) {
          await admin.query(
            `INSERT INTO platform.hotel_setup_property_scopes
             (database_login, property_id, organization_id, operation_class)
             VALUES ($1, $2, $3, $4)`,
            [role, properties[0], organizationId, index === 3 ? "currency_ready" : "feature_hub"],
          );
        }
        const loginUrl = new URL(url);
        loginUrl.username = role;
        loginUrl.password = passwords[index]!;
        const login = new pg.Client({ connectionString: loginUrl.toString() });
        await login.connect();
        logins.push(login);
      }
      for (let index = 0; index < 2; index++) {
        await admin.query("INSERT INTO identity.users (id,email) VALUES ($1,$2)", [
          users[index],
          `lock-${index}-${suffix}@example.test`,
        ]);
        await admin.query(
          "INSERT INTO identity.organization_memberships (organization_id,user_id,role_key,access_origin,property_access_mode) VALUES ($1,$2,$3,'agency','all')",
          [organizations[index], users[index], roleKeys[index]],
        );
        await admin.query(
          `INSERT INTO identity.role_permission_grants (organization_kind,role_key,permission_key)
           VALUES ('hotel_group',$1,'pms.operations.manage')`,
          [roleKeys[index]],
        );
        await admin.query(
          `INSERT INTO identity.product_entitlements (organization_id,product,entitlement_key,status)
           VALUES ($1,'pms','property-management','active')`,
          [organizations[index]],
        );
      }
      // Broad grants prove dependency RLS: even unfiltered SQL cannot read another hotel.
      const dependencies = [
        "pms.room_types",
        "pms.rate_plans",
        "pms.rate_rules",
        "pms.recurring_pricing_sources",
      ];
      for (const property of properties) {
        await admin.query(
          "INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ($1,'EUR')",
          [property],
        );
        const room = (
          await admin.query(
            "INSERT INTO pms.room_types (property_id,name,base_rate_amount,currency) VALUES ($1,'Dependency fixture',100,'EUR') RETURNING id",
            [property],
          )
        ).rows[0].id;
        await admin.query(
          "INSERT INTO pms.rate_plans (property_id,room_type_id,code,name,currency) VALUES ($1,$2,'dependency','Dependency fixture','EUR')",
          [property, room],
        );
        await admin.query(
          "INSERT INTO pms.rate_rules (property_id,room_type_id,rule_type,starts_on,ends_on) VALUES ($1,$2,'season',CURRENT_DATE,CURRENT_DATE)",
          [property, room],
        );
        await admin.query(
          "INSERT INTO pms.recurring_pricing_sources (id,property_id,source_kind,source_revision,configured_state,validation_state,validation_revision,validated_at,invalid_reasons,currency,source_pricing_currency_revision) VALUES (gen_random_uuid(),$1,'additional_guest',1,'active','valid',1,now(),'[]','EUR',1)",
          [property],
        );
      }
      for (const relation of dependencies) {
        for (const [loginIndex, visible] of [
          [0, properties[0]],
          [1, properties[1]],
          [3, properties[0]],
        ] as const)
          expect(
            (await logins[loginIndex]!.query(`SELECT property_id FROM ${relation}`)).rows,
          ).toEqual([{ property_id: visible }]);
        for (const loginIndex of [2, 4])
          expect(
            (await logins[loginIndex]!.query(`SELECT property_id FROM ${relation}`)).rows,
          ).toEqual([]);
        expect(
          (
            await logins[5]!.query(
              `SELECT property_id FROM ${relation} WHERE property_id=ANY($1::uuid[])`,
              [properties],
            )
          ).rowCount,
        ).toBe(2);
        // rate_rules updates enqueue Channex jobs; this dependency proof grants no queue writes.
        if (relation !== "pms.rate_rules")
          expect(
            (
              await logins[5]!.query(
                `UPDATE ${relation} SET property_id=property_id WHERE property_id=ANY($1::uuid[])`,
                [properties],
              )
            ).rowCount,
          ).toBe(2);
        await expect(
          logins[1]!.query(`UPDATE ${relation} SET property_id=property_id`),
        ).rejects.toMatchObject({ code: "42501" });
        expect((await logins[1]!.query(`DELETE FROM ${relation}`)).rowCount).toBe(0);
      }
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=false WHERE database_login=$1",
        [roles[1]],
      );
      for (const relation of dependencies)
        expect((await logins[1]!.query(`SELECT property_id FROM ${relation}`)).rows).toEqual([]);
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=true WHERE database_login=$1",
        [roles[1]],
      );
      for (const relation of [...dependencies].reverse())
        await admin.query(`DELETE FROM ${relation} WHERE property_id=ANY($1::uuid[])`, [
          properties,
        ]);
      await admin.query(
        "DELETE FROM pms.property_pricing_settings WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      // Broad local grants distinguish lock-only RLS from absent UPDATE privilege.
      for (const [relation, column, own, other] of [
        ["identity.organizations", "id", organizationId, organizations[1]],
        ["identity.users", "id", users[0], users[1]],
        ["identity.organization_memberships", "user_id", users[0], users[1]],
        ["identity.role_permission_grants", "role_key", roleKeys[0], roleKeys[1]],
        ["hotel_catalog.properties", "id", properties[0], properties[1]],
        [
          "identity.organization_resource_links",
          "resource_id",
          properties[0]!.toUpperCase(),
          properties[1],
        ],
        ["identity.product_entitlements", "organization_id", organizationId, organizations[1]],
      ] as const) {
        for (const lock of ["SHARE", "KEY SHARE", "UPDATE"])
          expect(
            (
              await logins[3]!.query(
                `SELECT ${column} FROM ${relation} WHERE ${column}=$1 FOR ${lock}`,
                [own],
              )
            ).rowCount,
          ).toBeGreaterThan(0);
        expect(
          (
            await logins[3]!.query(
              `SELECT ${column} FROM ${relation} WHERE ${column}=$1 FOR SHARE`,
              [other],
            )
          ).rows,
        ).toEqual([]);
        await expect(
          logins[3]!.query(`UPDATE ${relation} SET ${column}=${column} WHERE ${column}=$1`, [own]),
        ).rejects.toMatchObject({ code: "42501" });
        expect(
          (await logins[3]!.query(`DELETE FROM ${relation} WHERE ${column}=$1`, [own])).rowCount,
        ).toBe(0);
      }
      await expect(
        logins[3]!.query("INSERT INTO identity.users (email) VALUES ($1)", [
          `forbidden-${suffix}@example.test`,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[2]!.query("SELECT id FROM identity.organizations WHERE id=$1", [
            organizationId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[5]!.query(
            "UPDATE identity.users SET name='ordinary access retained' WHERE id=$1 RETURNING id",
            [users[0]],
          )
        ).rowCount,
      ).toBe(1);
      // The actual currency authorization join can now take all required locks.
      expect(
        (
          await logins[1]!.query(
            `SELECT property.id FROM hotel_catalog.properties property
         JOIN identity.organizations organization ON organization.id=$1
         JOIN identity.organization_resource_links resource ON resource.organization_id=organization.id
           AND resource.product='pms' AND resource.resource_id=property.id::text
         JOIN identity.users actor ON actor.id=$3
         JOIN identity.organization_memberships membership ON membership.organization_id=organization.id AND membership.user_id=actor.id
         JOIN identity.role_permission_grants permission_grant ON permission_grant.role_key=membership.role_key
           AND permission_grant.organization_kind='hotel_group' AND permission_grant.permission_key='pms.operations.manage'
         WHERE property.id=$2
         FOR SHARE OF property,organization,resource,actor,membership FOR KEY SHARE OF permission_grant`,
            [organizationId, properties[1], users[0]],
          )
        ).rowCount,
      ).toBe(1);
      // Run the currency repository with a native login, including real evidence SQL.
      const command = parseUpsertPropertyPricingCurrencyCommand({
        organizationId,
        propertyId: properties[1],
        currency: "EUR",
        expectedPricingCurrencyRevision: 0,
        idempotencyKey: `native-evidence-${suffix}`,
        audit: {
          actor: { kind: "user", userId: users[0] },
          requestId: suffix,
          correlationId: null,
          requestedAt: new Date().toISOString(),
        },
      });
      if (!command) throw new Error("invalid native currency fixture");
      const repositoryConfig = {
        connectionString: url,
        pool: scopePool(logins[1]!),
        hotelSetupCurrencyOperation: "currency" as const,
        currencyChangeGuard: {
          async runWithCurrencyChangeGuard() {
            throw new Error("initial currency does not need the change guard");
          },
        },
      };
      async function currencyCredentials(
        narrow: boolean,
        operation: "currency" | "currency_ready" = "currency",
      ) {
        const currencyGrants = Object.entries(
          operation === "currency_ready"
            ? HOTEL_SETUP_CURRENCY_READY_PRIVILEGES
            : HOTEL_SETUP_CURRENCY_PRIVILEGES,
        ).flatMap(([relation, privileges]) =>
          Object.entries(privileges).map(([privilege, columns]) => ({
            relation,
            privilege,
            columns: columns.join(","),
          })),
        );
        const role = roles[1]!;
        if (narrow) {
          await admin.query(`REVOKE ALL ON ${fixtureRelations.join(",")} FROM ${role}`);
          await admin.query(`REVOKE USAGE ON SCHEMA hotel_catalog FROM ${role}`);
        }
        for (const grant of currencyGrants)
          await admin.query(
            `${narrow ? "GRANT" : "REVOKE"} ${grant.privilege} (${grant.columns}) ON ${grant.relation} ${narrow ? "TO" : "FROM"} ${role}`,
          );
        if (!narrow) {
          await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog TO ${role}`);
          await admin.query(
            `GRANT SELECT,INSERT,UPDATE,DELETE ON ${fixtureRelations.join(",")} TO ${role}`,
          );
        }
      }
      const checkCurrency = (operation: "currency" | "currency_ready") =>
        withHotelSetupCommandScope(
          scopePool(logins[1]!),
          { organizationId, propertyId: properties[1]!, operation },
          () => assertHotelSetupCurrencyPrivileges(logins[1]!, operation),
        );
      await currencyCredentials(true);
      await checkCurrency("currency");
      await credentialPreflight("currency");
      await expect(
        logins[1]!.query(
          "INSERT INTO finance.expense_categories (property_id,name,color) VALUES ($1,'Forbidden','#FFFFFF')",
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const repository = createPgPmsPricingCommandRepository(repositoryConfig);
      const created = await repository.upsertPropertyPricingCurrency(command);
      expect(created).toMatchObject({ ok: true, response: { outcome: "created" } });
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
      await currencyCredentials(false);
      // Base PMS aliases share the same active/suspended semantics in the native command.
      for (const key of ["property-management", "pms-core", "account_access"]) {
        await admin.query(
          `UPDATE identity.product_entitlements SET entitlement_key=$1
          WHERE organization_id=$2 AND entitlement_key='property-management'`,
          [key, organizationId],
        );
        expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
        for (const patch of [
          "status='suspended'",
          "status='expired'",
          "starts_at=clock_timestamp()+interval '1 hour'",
          "expires_at=clock_timestamp()-interval '1 hour'",
        ]) {
          await admin.query(
            `UPDATE identity.product_entitlements SET ${patch}
            WHERE organization_id=$1 AND entitlement_key=$2`,
            [organizationId, key],
          );
          expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
            ok: false,
            error: { code: "setup_scope_unavailable" },
          });
          await admin.query(
            `UPDATE identity.product_entitlements SET status='active',starts_at=NULL,expires_at=NULL
            WHERE organization_id=$1 AND entitlement_key=$2`,
            [organizationId, key],
          );
        }
        await admin.query(
          `UPDATE identity.product_entitlements SET resource_product='pms',resource_type='pms_property',resource_id=$1
          WHERE organization_id=$2 AND entitlement_key=$3`,
          [properties[1]!.toUpperCase(), organizationId, key],
        );
        expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
        await admin.query(
          `UPDATE identity.product_entitlements SET resource_product=NULL,resource_type=NULL,resource_id=NULL,entitlement_key='property-management'
          WHERE organization_id=$1 AND entitlement_key=$2`,
          [organizationId, key],
        );
      }
      for (const resourceId of [null, properties[1]!.toUpperCase(), properties[0]]) {
        const veto = (
          await admin.query(
            `INSERT INTO identity.product_entitlements
          (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
          VALUES ($1,'pms','account_access','suspended',CASE WHEN $2::text IS NULL THEN NULL ELSE 'pms' END,
            CASE WHEN $2::text IS NULL THEN NULL ELSE 'pms_property' END,$2) RETURNING id`,
            [organizationId, resourceId],
          )
        ).rows[0].id;
        const result = await repository.upsertPropertyPricingCurrency(command);
        expect(result).toEqual(
          resourceId === properties[0]
            ? created
            : { ok: false, error: { code: "setup_scope_unavailable" } },
        );
        await admin.query(
          "UPDATE identity.product_entitlements SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
          [veto],
        );
        expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
        await admin.query("DELETE FROM identity.product_entitlements WHERE id=$1", [veto]);
      }
      await admin.query("UPDATE identity.users SET status='suspended' WHERE id=$1", [users[0]]);
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query("UPDATE identity.users SET status='active' WHERE id=$1", [users[0]]);
      // The uppercase canonical owner-link fixture must also pass native current authorization.
      await withHotelSetupCommandScope(
        scopePool(logins[0]!),
        {
          organizationId,
          propertyId: properties[0]!,
          operation: "currency",
        },
        async (client) => {
          expect(
            await lockHotelSetupCurrencyMembership(client, {
              ...command,
              propertyId: properties[0]!,
            }),
          ).toBe(true);
        },
      );
      // A replay still rechecks live membership access before returning old evidence.
      for (const patch of [
        "pms_access_enabled=false",
        "property_access_mode='assigned'",
        'permission_overrides=\'{"grant":[42],"deny":[]}\'::jsonb',
      ]) {
        await admin.query(
          `UPDATE identity.organization_memberships SET ${patch} WHERE user_id=$1`,
          [users[0]],
        );
        expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
          ok: false,
          error: { code: "setup_scope_unavailable" },
        });
        await admin.query(
          `UPDATE identity.organization_memberships SET
          pms_access_enabled=true, property_access_mode='all', permission_overrides=NULL WHERE user_id=$1`,
          [users[0]],
        );
      }
      const member = (
        await admin.query("SELECT id FROM identity.organization_memberships WHERE user_id=$1", [
          users[0],
        ])
      ).rows[0].id;
      await admin.query(
        "INSERT INTO identity.membership_property_assignments (membership_id,property_id) VALUES ($1,$2)",
        [member, properties[1]],
      );
      await admin.query(
        "UPDATE identity.organization_memberships SET property_access_mode='assigned' WHERE id=$1",
        [member],
      );
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
      for (const index of [0, 2])
        expect(
          (
            await logins[index]!.query(
              "SELECT property_id FROM identity.membership_property_assignments WHERE membership_id=$1",
              [member],
            )
          ).rows,
        ).toEqual([]);
      expect(
        (
          await logins[1]!.query(
            "SELECT property_id FROM identity.membership_property_assignments WHERE membership_id=$1 FOR SHARE",
            [member],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[1]!.query(
          "UPDATE identity.membership_property_assignments SET property_id=property_id WHERE membership_id=$1",
          [member],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[1]!.query(
            "DELETE FROM identity.membership_property_assignments WHERE membership_id=$1",
            [member],
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        logins[0]!.query(
          "INSERT INTO identity.membership_property_assignments (membership_id,property_id) VALUES ($1,$2)",
          [member, properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      await admin.query(
        `INSERT INTO identity.organization_roles
        (id,organization_id,name,security_class,base_role_key,default_permissions)
        VALUES ($1,$2,'Scoped role test','staff','hotel_custom','["pms.calendar.read"]')`,
        [roleDefinition, organizationId],
      );
      expect(
        (
          await logins[1]!.query(
            "SELECT id FROM identity.organization_roles WHERE id=$1 FOR SHARE",
            [roleDefinition],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await logins[2]!.query("SELECT id FROM identity.organization_roles WHERE id=$1", [
            roleDefinition,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        logins[1]!.query("UPDATE identity.organization_roles SET name=name WHERE id=$1", [
          roleDefinition,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[1]!.query("DELETE FROM identity.organization_roles WHERE id=$1", [
            roleDefinition,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        logins[1]!.query(
          `INSERT INTO identity.organization_roles
        (organization_id,name,security_class,base_role_key,default_permissions)
        VALUES ($1,'Forbidden role','staff','hotel_custom','[]')`,
          [organizationId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        "UPDATE identity.organization_memberships SET role_definition_id=$1 WHERE id=$2",
        [roleDefinition, member],
      );
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        "UPDATE identity.organization_memberships SET role_key='hotel_custom' WHERE id=$1",
        [member],
      );
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        "UPDATE identity.organization_memberships SET role_key=$1,role_definition_id=NULL,property_access_mode='all' WHERE id=$2",
        [roleKeys[0], member],
      );
      await admin.query("DELETE FROM identity.organization_roles WHERE id=$1", [roleDefinition]);
      await admin.query(
        "DELETE FROM identity.membership_property_assignments WHERE membership_id=$1",
        [member],
      );
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
      await inspector.connect();
      inspectorConnected = true;
      const membershipPid = (await logins[1]!.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // An entitlement that expires during a lock wait must deny an old accepted timestamp.
      await admin.query("BEGIN");
      transferOpen = true;
      await admin.query(
        `UPDATE identity.product_entitlements SET expires_at=clock_timestamp()+interval '100 milliseconds'
        WHERE organization_id=$1 AND entitlement_key='property-management'`,
        [organizationId],
      );
      const expiredReplay = repository.upsertPropertyPricingCurrency(command);
      void expiredReplay.catch(() => {});
      await expectBlocked(inspector, membershipPid);
      await admin.query("SELECT pg_sleep(0.2)");
      await admin.query("COMMIT");
      transferOpen = false;
      expect(await expiredReplay).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        "UPDATE identity.product_entitlements SET expires_at=NULL WHERE organization_id=$1 AND entitlement_key='property-management'",
        [organizationId],
      );
      // Routing a hidden row into scope must serialize too, even with unchanged organization_id.
      const writer = logins[5]!; // Ordinary ACL-backed login, not a setup role or superuser.
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const nativeClient = await scopePool(logins[1]!).connect();
      const retargetSql = `UPDATE identity.product_entitlements SET
        organization_id=$1,product='pms',entitlement_key=$2,
        resource_product=CASE WHEN $3::text IS NULL THEN NULL ELSE 'pms' END,
        resource_type=CASE WHEN $3::text IS NULL THEN NULL ELSE 'pms_property' END,
        resource_id=$3 WHERE id=$4`;
      for (const [sourceOrganization, sourceProduct, sourceKey, sourceProperty, targetKey] of [
        [organizationId, "pms", "unrelated", null, "pms-core"],
        [organizationId, "marketplace", "account_access", null, "account_access"],
        [organizationId, "pms", "property-management", properties[0], "property-management"],
        [organizations[1], "pms", "account_access", null, "account_access"],
      ] as const) {
        const entitlementId = randomUUID();
        const targetProperty = sourceProperty === null ? null : properties[1]!.toUpperCase();
        await admin.query(
          `INSERT INTO identity.product_entitlements
          (id,organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
          VALUES ($1,$2,$3,$4,'suspended',CASE WHEN $5::text IS NULL THEN NULL ELSE 'pms' END,
            CASE WHEN $5::text IS NULL THEN NULL ELSE 'pms_property' END,$5)`,
          [entitlementId, sourceOrganization, sourceProduct, sourceKey, sourceProperty],
        );
        let setupHoldsLock = true;
        try {
          // Setup wins: the hidden candidate cannot appear until setup has committed.
          await beginHotelSetupCommandScope(nativeClient, {
            organizationId,
            propertyId: properties[1]!,
            operation: "currency",
          });
          expect(await lockHotelSetupCurrencyMembership(nativeClient, command)).toBe(true);
          const retarget = writer.query(retargetSql, [
            organizationId,
            targetKey,
            targetProperty,
            entitlementId,
          ]);
          void retarget.catch(() => {});
          await expectBlocked(inspector, writerPid);
          expect(await lockHotelSetupCurrencyMembership(nativeClient, command)).toBe(true);
          await nativeClient.query("COMMIT");
          setupHoldsLock = false;
          await retarget;
          expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
            ok: false,
            error: { code: "setup_scope_unavailable" },
          });
          await admin.query(
            `UPDATE identity.product_entitlements SET organization_id=$1,product=$2,
            entitlement_key=$3,resource_product=CASE WHEN $4::text IS NULL THEN NULL ELSE 'pms' END,
            resource_type=CASE WHEN $4::text IS NULL THEN NULL ELSE 'pms_property' END,
            resource_id=$4 WHERE id=$5`,
            [sourceOrganization, sourceProduct, sourceKey, sourceProperty, entitlementId],
          );
          // Retarget wins: setup waits for its commit, then rejects the stale replay.
          await writer.query("BEGIN");
          await writer.query(retargetSql, [
            organizationId,
            targetKey,
            targetProperty,
            entitlementId,
          ]);
          const deniedReplay = repository.upsertPropertyPricingCurrency(command);
          void deniedReplay.catch(() => {});
          await expectBlocked(inspector, membershipPid);
          await writer.query("COMMIT");
          expect(await deniedReplay).toEqual({
            ok: false,
            error: { code: "setup_scope_unavailable" },
          });
        } finally {
          // Release the blocker before queueing rollback on its waiting peer.
          if (setupHoldsLock) {
            await nativeClient.query("ROLLBACK");
            await writer.query("ROLLBACK");
          } else {
            await writer.query("ROLLBACK");
            await nativeClient.query("ROLLBACK");
          }
          await admin.query("DELETE FROM identity.product_entitlements WHERE id=$1", [
            entitlementId,
          ]);
        }
      }
      // Reversed row/organization lock order must abort a transaction, not permit stale access.
      const baseEntitlement = (
        await admin.query(
          "SELECT id FROM identity.product_entitlements WHERE organization_id=$1 AND product='pms' AND entitlement_key='property-management' AND resource_product IS NULL",
          [organizationId],
        )
      ).rows[0].id;
      try {
        await beginHotelSetupCommandScope(nativeClient, {
          organizationId,
          propertyId: properties[1]!,
          operation: "currency",
        });
        const update = writer
          .query(
            "UPDATE identity.product_entitlements SET entitlement_key='pms-core',status='suspended' WHERE id=$1",
            [baseEntitlement],
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        await expectBlocked(inspector, writerPid);
        const checked = await lockHotelSetupCurrencyMembership(nativeClient, command).then(
          (allowed) => ({ allowed, error: null }),
          (error: unknown) => ({ allowed: false, error }),
        );
        await nativeClient.query(checked.error ? "ROLLBACK" : "COMMIT");
        const updateError = await update;
        expect(checked.error ?? updateError).toMatchObject({ code: "40P01" });
        if (!checked.error) expect(checked.allowed).toBe(true);
      } finally {
        await nativeClient.query("ROLLBACK");
        await writer.query("ROLLBACK");
        await admin.query(
          "UPDATE identity.product_entitlements SET entitlement_key='property-management',status='active' WHERE id=$1",
          [baseEntitlement],
        );
      }
      nativeClient.release();
      expect(
        (
          await admin.query(
            `SELECT tgenabled FROM pg_catalog.pg_trigger
          WHERE tgrelid='identity.product_entitlements'::regclass
            AND tgname='entitlement_routing_organization_lock'`,
          )
        ).rows,
      ).toEqual([{ tgenabled: "A" }]);
      for (const login of [logins[1]!, writer])
        expect(
          (
            await login.query(
              "SELECT has_function_privilege(current_user,'platform.lock_entitlement_routing_organization()','EXECUTE') AS allowed",
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
      // A revocation that started first must be visible after the lock wait.
      await admin.query("BEGIN");
      transferOpen = true;
      await admin.query(
        "UPDATE identity.organization_memberships SET pms_access_enabled=false WHERE id=$1",
        [member],
      );
      const revokedReplay = repository.upsertPropertyPricingCurrency(command);
      void revokedReplay.catch(() => {});
      await expectBlocked(inspector, membershipPid);
      await admin.query("COMMIT");
      transferOpen = false;
      expect(await revokedReplay).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        "UPDATE identity.organization_memberships SET pms_access_enabled=true WHERE id=$1",
        [member],
      );
      // If the setup check wins, the access writer waits until its transaction ends.
      const membershipClient = await scopePool(logins[1]!).connect();
      let revokeAfterSetup: Promise<unknown> | undefined;
      try {
        await beginHotelSetupCommandScope(membershipClient, {
          organizationId,
          propertyId: properties[1]!,
          operation: "currency",
        });
        expect(await lockHotelSetupCurrencyMembership(membershipClient, command)).toBe(true);
        const adminPid = (await admin.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        revokeAfterSetup = admin.query(
          "UPDATE identity.organization_memberships SET pms_access_enabled=false WHERE id=$1",
          [member],
        );
        void revokeAfterSetup.catch(() => {});
        await expectBlocked(inspector, adminPid);
        await membershipClient.query("COMMIT");
      } finally {
        await membershipClient.query("ROLLBACK");
      }
      await revokeAfterSetup;
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        "UPDATE identity.organization_memberships SET pms_access_enabled=true WHERE id=$1",
        [member],
      );
      for (const [relation, count] of [
        ["platform.idempotency_keys", 1],
        ["platform.domain_events", 1],
        ["platform.outbox_events", 2],
        ["platform.product_audit_events", 1],
      ] as const) {
        expect(
          (
            await logins[1]!.query(`SELECT id FROM ${relation} WHERE property_id=$1`, [
              properties[1],
            ])
          ).rowCount,
        ).toBe(count);
        for (const index of [0, 2, 3, 4])
          expect((await logins[index]!.query(`SELECT id FROM ${relation}`)).rows).toEqual([]);
        expect((await logins[1]!.query(`DELETE FROM ${relation}`)).rowCount).toBe(0);
        if (relation !== "platform.idempotency_keys")
          expect((await logins[1]!.query(`UPDATE ${relation} SET id=id`)).rowCount).toBe(0);
      }
      await expect(
        logins[1]!.query("UPDATE platform.idempotency_keys SET property_id=$1", [properties[0]]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[1]!.query("UPDATE platform.idempotency_keys SET operation='pms.other'"),
      ).rejects.toMatchObject({ code: "42501" });
      // Reuse valid rows; change one boundary field and require RLS denial.
      const clones = [
        [
          "platform.idempotency_keys",
          "operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,expires_at",
          "operation_scope,'pms.other',key_hash,request_fingerprint_hash,'in_progress',tenant_scope,property_id,expires_at",
        ],
        [
          "platform.domain_events",
          "source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload",
          "source_system,event_key||'.invalid','pms.other',occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload",
        ],
        [
          "platform.outbox_events",
          "domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash",
          "domain_event_id,outbox_key||'.invalid','provider.write',event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash",
        ],
        [
          "platform.product_audit_events",
          "audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,redacted_payload,audit_metadata",
          "audit_key||'.invalid',product,'pms.other',occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,redacted_payload,audit_metadata",
        ],
      ] as const;
      for (const [relation, columns, values] of clones)
        await expect(
          logins[1]!.query(
            `INSERT INTO ${relation} (${columns}) SELECT ${values} FROM ${relation} LIMIT 1`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      const event = (
        await admin.query("SELECT id FROM platform.domain_events WHERE property_id=$1", [
          properties[1],
        ])
      ).rows[0];
      await expect(
        logins[1]!.query(
          `INSERT INTO platform.domain_events
          (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,
           resource_product,resource_type,resource_id,actor_type,actor_user_id,payload)
         SELECT source_system,event_key||'.actor',event_type,occurred_at,tenant_scope,property_id,
           resource_product,resource_type,resource_id,'user',$1::uuid,payload
         FROM platform.domain_events WHERE id=$2`,
          [users[1], event.id],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[1]!.query(
          `INSERT INTO platform.outbox_events
          (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash)
         SELECT id,$1,'booking.pricing-source',event_type,'property',$2::uuid,'pms','property_pricing',$2::uuid::text,payload,idempotency_key_hash
         FROM platform.domain_events WHERE id=$3`,
          [`cross-${suffix}`, properties[0], event.id],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // An ordinary ACL-backed caller retains access to other event types.
      await logins[5]!.query(
        `INSERT INTO platform.domain_events (source_system,event_key,event_type,occurred_at,
          tenant_scope,property_id,resource_product,resource_type,resource_id)
         VALUES ('pms',$1,'pms.other',now(),'property',$2::uuid,'pms','property_pricing',$2::uuid::text)`,
        [`ordinary-${suffix}`, properties[1]],
      );
      expect((await logins[1]!.query("SELECT id FROM platform.domain_events")).rowCount).toBe(1);
      await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
        properties[1],
      ]);
      await admin.query(`REVOKE INSERT ON platform.product_audit_events FROM ${roles[1]}`);
      await expect(
        repository.upsertPropertyPricingCurrency({
          ...command,
          idempotencyKey: `native-rollback-${suffix}`,
        }),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([]);
      for (const [relation, count] of [
        ["idempotency_keys", 1],
        ["domain_events", 2],
        ["outbox_events", 2],
        ["product_audit_events", 1],
      ] as const)
        expect(
          (
            await admin.query(`SELECT id FROM platform.${relation} WHERE property_id=$1`, [
              properties[1],
            ])
          ).rowCount,
        ).toBe(count);
      await admin.query(`GRANT INSERT ON platform.product_audit_events TO ${roles[1]}`);
      const keySql = `INSERT INTO platform.idempotency_keys
        (operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
        VALUES ('pms','pms.pricing_currency.upsert',$1,$1,'property',$2,now()+interval '1 hour')`;
      for (const index of [1, 2, 4])
        await expect(
          logins[index]!.query(keySql, [`deny-${index}-${suffix}`, properties[0]]),
        ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await logins[3]!.query(keySql, [`readiness-${suffix}`, properties[0]])).rowCount,
      ).toBe(1);
      // The first-save class includes categories on this same native transaction.
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='currency_ready' WHERE database_login=$1",
        [roles[1]],
      );
      const readiness = createPgPmsPricingCommandRepository({
        ...repositoryConfig,
        hotelSetupCurrencyOperation: "currency_ready",
      });
      const firstSave = { ...command, idempotencyKey: `native-first-save-${suffix}` };
      await admin.query(
        "INSERT INTO finance.expense_categories (property_id,system_key,name,color,archived_at) VALUES ($1,'staff','Archived payroll','#112233',now())",
        [properties[1]],
      );
      await expect(readiness.upsertPropertyPricingCurrency(firstSave)).rejects.toThrow(
        "categories incomplete",
      );
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM finance.expense_categories WHERE property_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      await admin.query("DELETE FROM finance.expense_categories WHERE property_id=$1", [
        properties[1],
      ]);
      await admin.query(`REVOKE INSERT ON platform.product_audit_events FROM ${roles[1]}`);
      await expect(readiness.upsertPropertyPricingCurrency(firstSave)).rejects.toMatchObject({
        code: "42501",
      });
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await admin.query("SELECT id FROM finance.expense_categories WHERE property_id=$1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await admin.query(`GRANT INSERT ON platform.product_audit_events TO ${roles[1]}`);
      const beforeCompletion = (statements: readonly string[], omit?: "audit" | "outbox") =>
        createPgPmsPricingCommandRepository({
          ...repositoryConfig,
          hotelSetupCurrencyOperation: "currency_ready",
          pool: {
            async end() {},
            async connect() {
              const client = await scopePool(logins[1]!).connect();
              return {
                ...client,
                async query<T>(sql: string, values?: readonly unknown[]) {
                  if (
                    (omit === "audit" &&
                      sql.includes("INSERT INTO platform.product_audit_events")) ||
                    (omit === "outbox" &&
                      sql.includes("INSERT INTO platform.outbox_events") &&
                      values?.[2] === "finance.pricing-source")
                  )
                    return { rows: [] as T[], rowCount: 1 };
                  if (sql === "COMMIT")
                    for (const statement of statements)
                      await logins[1]!.query(
                        statement,
                        statement.includes("$1") ? [properties[1]] : [],
                      );
                  return client.query<T>(sql, values);
                },
              };
            },
          },
        });
      for (const [statements, message] of [
        [
          [
            "SET CONSTRAINTS ALL IMMEDIATE",
            "UPDATE pms.property_pricing_settings SET currency='USD',pricing_currency_revision=2 WHERE property_id=$1",
          ],
          "completion evidence is sealed",
        ],
        [
          [
            "SET CONSTRAINTS ALL IMMEDIATE",
            "UPDATE platform.idempotency_keys SET status='failed' WHERE property_id=$1",
          ],
          "completion evidence is sealed",
        ],
        [
          [
            "UPDATE pms.property_pricing_settings SET currency='USD',pricing_currency_revision=2 WHERE property_id=$1",
          ],
          "first currency invalid",
        ],
        [
          ["UPDATE platform.idempotency_keys SET status='failed' WHERE property_id=$1"],
          "query returned no rows",
        ],
      ] as const) {
        await expect(
          beforeCompletion(statements).upsertPropertyPricingCurrency(firstSave),
        ).rejects.toThrow(message);
        for (const relation of ["pms.property_pricing_settings", "finance.expense_categories"])
          expect(
            (
              await admin.query(`SELECT property_id FROM ${relation} WHERE property_id=$1`, [
                properties[1],
              ])
            ).rows,
          ).toEqual([]);
        expect(
          (
            await admin.query(
              "SELECT status,metadata->>'newHotelFinancialsDefault' AS marker FROM identity.product_entitlements WHERE resource_id=$1",
              [properties[1]],
            )
          ).rows,
        ).toEqual([{ status: "suspended", marker: "pending" }]);
      }
      for (const omit of ["audit", "outbox"] as const)
        await expect(
          beforeCompletion([], omit).upsertPropertyPricingCurrency(firstSave),
        ).rejects.toMatchObject({ code: "P0002" });
      await expect(
        logins[1]!.query("SELECT platform.complete_hotel_setup_first_currency()"),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        "INSERT INTO identity.product_entitlements (organization_id,product,entitlement_key,status) VALUES ($1,'pms','module:financials','suspended')",
        [organizationId],
      );
      await expect(readiness.upsertPropertyPricingCurrency(firstSave)).rejects.toThrow(
        "prerequisites incomplete",
      );
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=$1 AND entitlement_key='module:financials' AND resource_id IS NULL",
        [organizationId],
      );
      await admin.query(
        "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 hour' WHERE resource_id=$1",
        [properties[1]],
      );
      await expect(readiness.upsertPropertyPricingCurrency(firstSave)).rejects.toThrow(
        "prerequisites incomplete",
      );
      await admin.query(
        "UPDATE identity.product_entitlements SET expires_at=NULL WHERE resource_id=$1",
        [properties[1]],
      );
      for (const currency of ["BTC", "EUR"])
        await expect(
          withHotelSetupCommandScope(
            scopePool(logins[1]!),
            {
              propertyId: properties[1]!,
              organizationId,
              operation: "currency_ready",
            },
            async (client) => {
              await client.query(
                "INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ($1,$2)",
                [properties[1], currency],
              );
            },
          ),
        ).rejects.toThrow(
          currency === "BTC" ? "first currency invalid" : "prerequisites incomplete",
        );
      await currencyCredentials(true, "currency_ready");
      await checkCurrency("currency_ready");
      await credentialPreflight("currency_ready");
      for (const [drift, restore] of [
        [
          `GRANT SELECT (private_payload) ON platform.product_audit_events TO ${roles[1]}`,
          `REVOKE SELECT (private_payload) ON platform.product_audit_events FROM ${roles[1]}`,
        ],
        [
          `GRANT UPDATE (payload) ON platform.domain_events TO ${roles[1]}`,
          `REVOKE UPDATE (payload) ON platform.domain_events FROM ${roles[1]}`,
        ],
        [
          `REVOKE SELECT (currency) ON pms.property_pricing_settings FROM ${roles[1]}`,
          `GRANT SELECT (currency) ON pms.property_pricing_settings TO ${roles[1]}`,
        ],
        [
          "ALTER TABLE pms.property_pricing_settings DISABLE TRIGGER hotel_setup_first_currency_completion",
          "ALTER TABLE pms.property_pricing_settings ENABLE ALWAYS TRIGGER hotel_setup_first_currency_completion",
        ],
      ]) {
        await admin.query(drift!);
        try {
          await expect(checkCurrency("currency_ready")).rejects.toThrow(/mismatch/);
        } finally {
          await admin.query(restore!);
        }
        await checkCurrency("currency_ready");
      }
      const firstSaved = await beforeCompletion([
        'UPDATE platform.idempotency_keys SET idempotency_metadata=idempotency_metadata||\'{"hotelSetupTransaction":"forged"}\'::jsonb WHERE property_id=$1',
        "SET CONSTRAINTS ALL IMMEDIATE",
      ]).upsertPropertyPricingCurrency(firstSave);
      expect(firstSaved).toMatchObject({ ok: true, response: { outcome: "created" } });
      expect(await readiness.upsertPropertyPricingCurrency(firstSave)).toEqual(firstSaved);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM finance.expense_categories WHERE property_id=$1 AND archived_at IS NULL",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ count: 7 }]);
      expect(
        (
          await admin.query(
            "SELECT status,metadata->>'newHotelFinancialsDefault' AS marker FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ status: "active", marker: "ready" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1 AND action='pms.financials.default_activated'",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await admin.query(
            `SELECT count(*)::int AS count FROM platform.product_audit_events activation
        JOIN platform.product_audit_events source ON source.id::text=activation.audit_metadata->>'sourceAuditId'
        JOIN platform.idempotency_keys k ON k.id=activation.idempotency_key_id
        JOIN platform.domain_events e ON e.id=activation.domain_event_id
        JOIN platform.outbox_events o ON o.domain_event_id=e.id
        JOIN identity.product_entitlements entitlement ON entitlement.resource_id=activation.property_id::text
        WHERE activation.property_id=$1 AND activation.action='pms.financials.default_activated'
          AND activation.actor_user_id=source.actor_user_id AND source.idempotency_key_id=k.id
          AND activation.correlation_id=source.correlation_id
          AND entitlement.metadata->>'newHotelFinancialsActivationTransaction'=k.idempotency_metadata->>'hotelSetupTransaction'
          AND source.audit_metadata->>'hotelSetupTransaction'=k.idempotency_metadata->>'hotelSetupTransaction'
          AND e.event_metadata->>'hotelSetupTransaction'=k.idempotency_metadata->>'hotelSetupTransaction'
          AND o.outbox_metadata->>'hotelSetupTransaction'=k.idempotency_metadata->>'hotelSetupTransaction'`,
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      await currencyCredentials(false, "currency_ready");
      // The audited Feature Hub capability preserves setup data and cannot undo billing.
      await admin.query(
        "INSERT INTO identity.role_permission_grants (organization_kind,role_key,permission_key) VALUES ('hotel_group',$1,'pms.finance.manage')",
        [roleKeys[0]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='feature_hub' WHERE database_login=$1",
        [roles[1]],
      );
      // The real switch must work with only its reviewed column grants.
      const nativeRole = roles[1]!;
      await admin.query(
        `REVOKE ALL ON ${fixtureRelations.join(",")},pms.room_types,pms.rate_plans FROM ${nativeRole}`,
      );
      await admin.query(`REVOKE USAGE ON SCHEMA hotel_catalog,pms,finance FROM ${nativeRole}`);
      const nativeGrants = Object.entries(HOTEL_SETUP_FEATURE_HUB_PRIVILEGES).flatMap(
        ([relation, privileges]) =>
          Object.entries(privileges).map(([privilege, columns]) => ({
            relation,
            privilege,
            columns: columns.join(","),
          })),
      );
      for (const grant of nativeGrants)
        await admin.query(
          `GRANT ${grant.privilege} (${grant.columns}) ON ${grant.relation} TO ${nativeRole}`,
        );
      const checkNative = () =>
        withHotelSetupCommandScope(
          scopePool(logins[1]!),
          { organizationId, propertyId: properties[1]!, operation: "feature_hub" },
          () => assertHotelSetupFeatureHubPrivileges(logins[1]!),
        );
      await checkNative();
      await credentialPreflight("feature_hub");
      const linkFunction = (
        await admin.query(
          "SELECT pg_catalog.pg_get_functiondef('platform.hotel_setup_property_link_matches(uuid,text)'::regprocedure) AS definition",
        )
      ).rows[0].definition as string;
      for (const [drift, restore] of [
        [
          "REVOKE EXECUTE ON FUNCTION platform.hotel_setup_property_financials_read_allowed(uuid,text,text,text,text,text) FROM vayada_next_hotel_setup_property_scope",
          "GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_financials_read_allowed(uuid,text,text,text,text,text) TO vayada_next_hotel_setup_property_scope",
        ],
        [
          `GRANT SELECT (id) ON identity.users TO ${nativeRole} WITH GRANT OPTION`,
          `REVOKE GRANT OPTION FOR SELECT (id) ON identity.users FROM ${nativeRole}`,
        ],
        [
          `GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_allowed(uuid,uuid) TO ${nativeRole} WITH GRANT OPTION`,
          `REVOKE EXECUTE ON FUNCTION platform.hotel_setup_property_allowed(uuid,uuid) FROM ${nativeRole}`,
        ],
        [
          linkFunction.replace("RETURN property_id = resource_id::uuid;", "RETURN TRUE;"),
          linkFunction,
        ],
        [
          "ALTER POLICY hotel_setup_property_identity_update_scope ON identity.users WITH CHECK (true)",
          "ALTER POLICY hotel_setup_property_identity_update_scope ON identity.users WITH CHECK (false)",
        ],
        [
          "GRANT SELECT (email) ON identity.users TO PUBLIC",
          "REVOKE SELECT (email) ON identity.users FROM PUBLIC",
        ],
        [
          `GRANT SELECT (email) ON identity.users TO ${nativeRole}`,
          `REVOKE SELECT (email) ON identity.users FROM ${nativeRole}`,
        ],
        [
          `GRANT UPDATE (status) ON identity.product_entitlements TO ${nativeRole}`,
          `REVOKE UPDATE (status) ON identity.product_entitlements FROM ${nativeRole}`,
        ],
        [
          "ALTER TABLE identity.users DISABLE ROW LEVEL SECURITY",
          "ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY",
        ],
        [
          "ALTER FUNCTION platform.hotel_setup_property_assigned_organization() SET search_path=public",
          "ALTER FUNCTION platform.hotel_setup_property_assigned_organization() SET search_path=pg_catalog",
        ],
        [
          `GRANT SET ON PARAMETER session_replication_role TO ${nativeRole}`,
          `REVOKE SET ON PARAMETER session_replication_role FROM ${nativeRole}`,
        ],
      ]) {
        await admin.query(drift!);
        try {
          await expect(checkNative()).rejects.toThrow(/Hotel setup/);
        } finally {
          await admin.query(restore!);
        }
      }
      await checkNative();
      const featureHub = createPgHotelSetupFeatureHubRepository({
        connectionString: url,
        pool: scopePool(logins[1]!),
      });
      const featureContext = {
        actor: { internalUserId: users[0] },
        selectedOrganization: { organizationId },
        audit: { requestId: `feature-${suffix}`, receivedAt: new Date().toISOString() },
      } as RequestContext;
      const toggle = (enabled: boolean) =>
        featureHub.updateFinancials(featureContext, properties[1]!, enabled);
      const dataBefore = (
        await admin.query(
          "SELECT to_jsonb(p) AS currency,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM finance.expense_categories c WHERE property_id=$1) AS categories FROM pms.property_pricing_settings p WHERE property_id=$1",
          [properties[1]],
        )
      ).rows;
      const auditCount = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform.product_audit_events WHERE property_id=$1 AND action IN ('financials_module_activated','financials_module_deactivated')",
            [properties[1]],
          )
        ).rows[0].n;
      await logins[1]!.query("SET plan_cache_mode=force_generic_plan");
      expect(await toggle(false)).toMatchObject({ isActive: false });
      expect(await toggle(false)).toMatchObject({ isActive: false });
      expect(await toggle(true)).toMatchObject({ isActive: true });
      expect(await auditCount()).toBe(3);
      await logins[1]!.query("RESET plan_cache_mode");
      expect(
        (
          await admin.query(
            "SELECT to_jsonb(p) AS currency,(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM finance.expense_categories c WHERE property_id=$1) AS categories FROM pms.property_pricing_settings p WHERE property_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual(dataBefore);
      await expect(
        featureHub.updateFinancials(featureContext, properties[0]!, false),
      ).rejects.toThrow();
      await admin.query(
        "DELETE FROM identity.role_permission_grants WHERE role_key=$1 AND permission_key='pms.finance.manage'",
        [roleKeys[0]],
      );
      await expect(toggle(false)).rejects.toThrow();
      await admin.query(
        "INSERT INTO identity.role_permission_grants (organization_kind,role_key,permission_key) VALUES ('hotel_group',$1,'pms.finance.manage')",
        [roleKeys[0]],
      );
      await admin.query(
        `REVOKE INSERT (${HOTEL_SETUP_FEATURE_HUB_PRIVILEGES["platform.product_audit_events"]!.INSERT!.join(",")}) ON platform.product_audit_events FROM ${roles[1]}`,
      );
      await expect(toggle(false)).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await admin.query(
            "SELECT status FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ status: "active" }]);
      await admin.query(
        `GRANT INSERT (${HOTEL_SETUP_FEATURE_HUB_PRIVILEGES["platform.product_audit_events"]!.INSERT!.join(",")}) ON platform.product_audit_events TO ${roles[1]}`,
      );
      await expect(
        logins[1]!.query(
          "UPDATE identity.product_entitlements SET status='active' WHERE resource_id=$1",
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[1]!.query("UPDATE identity.product_entitlements SET id=id WHERE resource_id=$1", [
          properties[1],
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[1]!.query("SELECT platform.apply_hotel_setup_feature_hub_command()"),
      ).rejects.toMatchObject({ code: "42501" });
      await toggle(false);
      // Skipped audit insertion must not execute the command's side effect.
      const previousAudit = (
        await admin.query(
          "SELECT audit_key FROM platform.product_audit_events WHERE property_id=$1 AND action='financials_module_deactivated' ORDER BY occurred_at DESC LIMIT 1",
          [properties[1]],
        )
      ).rows[0].audit_key;
      const skipped = await logins[1]!.query(
        `INSERT INTO platform.product_audit_events
        (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
          target_resource_product,target_resource_type,target_resource_id,redacted_payload,retention_class,privacy_scope)
        VALUES ($1,'pms','financials_module_activated',clock_timestamp(),'property',$2::uuid,'user',$3,
          'pms','pms_property',$2::uuid::text,jsonb_build_object('moduleId','financials','isActive',true),
          'financial','internal') ON CONFLICT (product,audit_key) DO NOTHING`,
        [previousAudit, properties[1], users[0]],
      );
      expect(skipped.rowCount).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT status FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ status: "suspended" }]);
      // A subsequent trusted writer invalidates the Owner-off receipt even on a no-op.
      await admin.query(
        "UPDATE identity.product_entitlements SET updated_at=updated_at WHERE resource_id=$1",
        [properties[1]],
      );
      await toggle(false);
      await expect(toggle(true)).rejects.toThrow("activation unavailable");
      await admin.query(
        "UPDATE identity.product_entitlements SET status='active' WHERE resource_id=$1",
        [properties[1]],
      );
      await admin.query(
        "INSERT INTO identity.product_entitlements (organization_id,product,entitlement_key,status,metadata) VALUES ($1,'pms','module:financials','suspended','{\"newHotelFinancialsOwnerDisabled\":true}') RETURNING metadata AS clean",
        [organizationId],
      );
      expect(
        (
          await admin.query(
            "SELECT metadata ? 'newHotelFinancialsOwnerDisabled' AS copied FROM identity.product_entitlements WHERE organization_id=$1 AND resource_id IS NULL AND entitlement_key='module:financials'",
            [organizationId],
          )
        ).rows,
      ).toEqual([{ copied: false }]);
      await toggle(false);
      await expect(toggle(true)).rejects.toThrow("activation unavailable");
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=$1 AND entitlement_key='module:financials' AND resource_id IS NULL",
        [organizationId],
      );
      await admin.query(
        "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1 AND entitlement_key='property-management'",
        [organizationId],
      );
      await toggle(false);
      await expect(toggle(true)).rejects.toThrow();
      await admin.query(
        "UPDATE identity.product_entitlements SET status='active' WHERE organization_id=$1 AND entitlement_key='property-management'",
        [organizationId],
      );
      await toggle(true);
      await toggle(false);
      for (const grant of nativeGrants)
        await admin.query(
          `REVOKE ${grant.privilege} (${grant.columns}) ON ${grant.relation} FROM ${nativeRole}`,
        );
      await admin.query(`GRANT USAGE ON SCHEMA hotel_catalog,pms,finance TO ${nativeRole}`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ${fixtureRelations.join(",")} TO ${nativeRole}`,
      );
      await admin.query(`GRANT SELECT ON pms.room_types,pms.rate_plans TO ${nativeRole}`);
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='currency_ready' WHERE database_login=$1",
        [roles[1]],
      );
      // Owner off is preserved by replay and subsequent currency updates.
      await admin.query(
        "UPDATE identity.product_entitlements SET status='suspended' WHERE resource_id=$1",
        [properties[1]],
      );
      expect(await readiness.upsertPropertyPricingCurrency(firstSave)).toEqual(firstSaved);
      await currencyCredentials(true, "currency_ready");
      await checkCurrency("currency_ready");
      const updater = createPgPmsPricingCommandRepository({
        ...repositoryConfig,
        hotelSetupCurrencyOperation: "currency_ready",
        // This fixture has no dependencies; the real shared dependency guard has separate proofs.
        currencyChangeGuard: {
          async runWithCurrencyChangeGuard(_input, guarded) {
            return guarded([]);
          },
        },
      });
      const updateCommand = parseUpsertPropertyPricingCurrencyCommand({
        ...firstSave,
        currency: "USD",
        expectedPricingCurrencyRevision: 1,
        idempotencyKey: `native-narrow-update-${suffix}`,
      });
      if (!updateCommand) throw new Error("invalid native update fixture");
      const updated = await updater.upsertPropertyPricingCurrency(updateCommand);
      expect(updated).toMatchObject({
        ok: true,
        response: {
          outcome: "updated",
          pricingCurrency: { currency: "USD", pricingCurrencyRevision: 2 },
        },
      });
      await currencyCredentials(false, "currency_ready");
      expect(
        (
          await admin.query(
            "SELECT status FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[1]],
          )
        ).rows,
      ).toEqual([{ status: "suspended" }]);
      await admin.query(
        "UPDATE identity.product_entitlements SET metadata=metadata-'newHotelFinancialsActivationTransaction'||'{\"newHotelFinancialsDefault\":\"pending\"}'::jsonb WHERE resource_id=$1",
        [properties[1]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET operation_class='currency' WHERE database_login=$1",
        [roles[1]],
      );
      await admin.query("DELETE FROM finance.expense_categories WHERE property_id=$1", [
        properties[1],
      ]);
      await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
        properties[1],
      ]);
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE entitlement_key='property-management' AND organization_id=ANY($1::uuid[])",
        [organizations],
      );
      for (const [loginIndex, propertyIndex, operation, allowed] of [
        [0, 0, "currency", true],
        [0, 0, "currency_ready", false],
        [3, 0, "currency_ready", true],
        [3, 0, "feature_hub", false],
        [3, 1, "currency_ready", false],
        [4, 0, "feature_hub", true],
        [4, 0, "currency", false],
      ] as const) {
        const result = await logins[loginIndex]!.query<{ allowed: boolean }>(
          `SELECT platform.hotel_setup_property_operation_allowed($1::uuid, $2::text)
             AS allowed`,
          [properties[propertyIndex], operation],
        );
        expect(result.rows[0]?.allowed).toBe(allowed);
        const preflight = withHotelSetupCommandScope(
          scopePool(logins[loginIndex]!),
          {
            propertyId: properties[propertyIndex]!,
            organizationId,
            operation,
          },
          async () => undefined,
        );
        if (allowed) await expect(preflight).resolves.toBeUndefined();
        else await expect(preflight).rejects.toThrow("scope preflight failed");
        if (!allowed && operation !== "feature_hub") {
          const command = parseUpsertPropertyPricingCurrencyCommand({
            organizationId,
            propertyId: properties[propertyIndex],
            currency: "EUR",
            expectedPricingCurrencyRevision: 0,
            idempotencyKey: `native-denial-${suffix}-${loginIndex}-${operation}`,
            audit: {
              actor: { kind: "user", userId: randomUUID() },
              requestId: suffix,
              correlationId: null,
              requestedAt: new Date().toISOString(),
            },
          });
          if (!command) throw new Error("invalid currency command fixture");
          const repository = createPgPmsPricingCommandRepository({
            connectionString: url,
            pool: scopePool(logins[loginIndex]!),
            hotelSetupCurrencyOperation: operation,
            currencyChangeGuard: {
              async runWithCurrencyChangeGuard() {
                throw new Error("guard must not run");
              },
            },
          });
          await expect(repository.upsertPropertyPricingCurrency(command)).rejects.toThrow(
            "Hotel setup command scope preflight failed",
          );
        }
      }
      // Native category/currency SQL proof; full-handler ACL provisioning is a separate gate.
      const categoryScope = {
        propertyId: properties[0]!,
        organizationId,
        operation: "currency_ready" as const,
      };
      await admin.query(
        `INSERT INTO finance.expense_categories (property_id, system_key, name, color)
         VALUES ($1, 'staff', 'Our payroll', '#112233')`,
        [properties[0]],
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await withHotelSetupCommandScope(scopePool(logins[3]!), categoryScope, async (client) => {
          await seedPendingHotelFinancialsCategories(client, categoryScope);
        });
      }
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM finance.expense_categories WHERE property_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([{ count: 7 }]);
      expect(
        (
          await admin.query(
            "SELECT name, color FROM finance.expense_categories WHERE property_id=$1 AND system_key='staff'",
            [properties[0]],
          )
        ).rows,
      ).toEqual([{ name: "Our payroll", color: "#112233" }]);
      expect(
        (
          await admin.query("SELECT id FROM finance.expense_categories WHERE property_id=$1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await admin.query("DELETE FROM finance.expense_categories WHERE property_id=$1", [
        properties[0],
      ]);
      await admin.query(
        `INSERT INTO finance.expense_categories (property_id, system_key, name, color, archived_at)
         VALUES ($1, 'staff', 'Archived payroll', '#112233', now())`,
        [properties[0]],
      );
      await expect(
        withHotelSetupCommandScope(scopePool(logins[3]!), categoryScope, async (client) => {
          await client.query(
            "INSERT INTO pms.property_pricing_settings (property_id, currency) VALUES ($1, 'EUR')",
            [properties[0]],
          );
          await seedPendingHotelFinancialsCategories(client, categoryScope);
        }),
      ).rejects.toThrow("categories incomplete");
      expect(
        (
          await admin.query(
            "SELECT system_key, archived_at IS NOT NULL AS archived FROM finance.expense_categories WHERE property_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([{ system_key: "staff", archived: true }]);
      expect(
        (
          await admin.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([]);
      await admin.query("DELETE FROM finance.expense_categories WHERE property_id=$1", [
        properties[0],
      ]);

      const lockInspector = new pg.Client({ connectionString: url });
      await lockInspector.connect();
      let releaseWrite!: () => void;
      let scopeChecked!: () => void;
      const writeCanFinish = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const preflightFinished = new Promise<void>((resolve) => {
        scopeChecked = resolve;
      });
      const scopedWrite = withHotelSetupCommandScope(
        scopePool(logins[3]!),
        {
          propertyId: properties[0]!,
          organizationId,
          operation: "currency_ready",
        },
        async (client) => {
          scopeChecked();
          await writeCanFinish;
          await client.query("SELECT 1");
        },
      );
      await preflightFinished;
      await admin.query("BEGIN");
      try {
        const adminPid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const revoke = admin.query(
          "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
          [roles[3]],
        );
        void revoke.catch(() => {});
        await expectBlocked(lockInspector, adminPid);
        releaseWrite();
        await scopedWrite;
        await revoke;
      } finally {
        releaseWrite();
        await admin.query("ROLLBACK");
        await lockInspector.end();
      }
      await admin.query(`CREATE TABLE public.${ownedRelation} (id integer)`);
      await admin.query(`ALTER TABLE public.${ownedRelation} OWNER TO ${roles[3]}`);
      await expect(
        withHotelSetupCommandScope(
          scopePool(logins[3]!),
          {
            propertyId: properties[0]!,
            organizationId,
            operation: "currency_ready",
          },
          async () => undefined,
        ),
      ).rejects.toThrow("scope preflight failed");
      await admin.query(`DROP TABLE public.${ownedRelation}`);
      const suspensionObserver = new pg.Client({ connectionString: url });
      await suspensionObserver.connect();
      const setupLogin = logins[3]!;
      const scope = {
        propertyId: properties[0]!,
        organizationId,
        operation: "currency_ready" as const,
      };
      const suspensionSql = `INSERT INTO identity.product_entitlements
        (organization_id,product,entitlement_key,status) VALUES ($1,'pms','pms-core','suspended')`;
      try {
        // Setup first: the insert's organization FK lock waits for setup commit.
        await setupLogin.query("BEGIN");
        await setupLogin.query("SELECT platform.hotel_setup_property_allowed($1,$2)", [
          properties[0],
          organizationId,
        ]);
        await admin.query("BEGIN");
        const adminPid = (await admin.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        const insert = admin.query(suspensionSql, [organizationId]);
        void insert.catch(() => {});
        await expectBlocked(suspensionObserver, adminPid);
        expect(
          (
            await setupLogin.query(
              "SELECT status FROM identity.product_entitlements WHERE entitlement_key='pms-core'",
            )
          ).rows,
        ).toEqual([]);
        await setupLogin.query("COMMIT");
        await insert;
        await admin.query("COMMIT");
        await admin.query(
          "DELETE FROM identity.product_entitlements WHERE organization_id=$1 AND entitlement_key='pms-core'",
          [organizationId],
        );

        // Suspension first: setup waits, then observes the committed row.
        await admin.query("BEGIN");
        await admin.query(suspensionSql, [organizationId]);
        const setupPid = (await setupLogin.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        const setup = withHotelSetupCommandScope(scopePool(setupLogin), scope, async (client) => {
          return (
            await client.query(
              "SELECT status FROM identity.product_entitlements WHERE entitlement_key='pms-core'",
            )
          ).rows;
        });
        void setup.catch(() => {});
        await expectBlocked(suspensionObserver, setupPid);
        await admin.query("COMMIT");
        expect(await setup).toEqual([{ status: "suspended" }]);
        await admin.query(
          "DELETE FROM identity.product_entitlements WHERE organization_id=$1 AND entitlement_key='pms-core'",
          [organizationId],
        );

        for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
          await setupLogin.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          expect(
            (
              await setupLogin.query(
                "SELECT platform.hotel_setup_property_allowed($1,$2) AS allowed",
                [properties[0], organizationId],
              )
            ).rows,
          ).toEqual([{ allowed: false }]);
          await expect(
            setupLogin.query(
              "INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ($1,'EUR')",
              [properties[0]],
            ),
          ).rejects.toMatchObject({ code: "42501" });
          await setupLogin.query("ROLLBACK");
        }
      } finally {
        await setupLogin.query("ROLLBACK");
        await admin.query("ROLLBACK");
        await suspensionObserver.end();
      }
      expect(
        (
          await logins[4]!.query("SELECT id FROM hotel_catalog.properties WHERE id=$1", [
            properties[0],
          ])
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[4]!.query(
          "INSERT INTO pms.property_pricing_settings (property_id, currency) VALUES ($1, 'USD')",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[4]!.query(
          "INSERT INTO finance.expense_categories (property_id, name, color) VALUES ($1, 'Other', '#6366F1')",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[3]!.query(
            "INSERT INTO finance.expense_categories (property_id, name, color) VALUES ($1, 'Other', '#6366F1')",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
        [organizations[1], properties[0]!.toUpperCase()],
      );
      expect(
        (
          await logins[0]!.query(
            "SELECT organization_id FROM identity.organization_resource_links WHERE resource_id=$1",
            [properties[0]!.toUpperCase()],
          )
        ).rows,
      ).toEqual([{ organization_id: organizationId }, { organization_id: organizationId }]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links
         WHERE organization_id=$1 AND resource_id=$2`,
        [organizations[1], properties[0]!.toUpperCase()],
      );

      expect(
        (
          await logins[0]!.query(
            "SELECT resource_id FROM identity.product_entitlements WHERE entitlement_key='module:financials'",
          )
        ).rows,
      ).toEqual([{ resource_id: properties[0] }]);
      await expect(
        logins[0]!.query("SET ROLE vayada_next_hotel_setup_property_scope"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            `INSERT INTO pms.property_pricing_settings (property_id, currency)
         VALUES ($1, 'USD') RETURNING property_id`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[0]!.query(
          `INSERT INTO pms.property_pricing_settings (property_id, currency)
         VALUES ($1, 'EUR')`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            `INSERT INTO finance.expense_categories
           (property_id, system_key, name, color, sort_order)
         VALUES ($1, 'staff', 'Staff', '#6366F1', 10) RETURNING id`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[0]!.query(
          `INSERT INTO finance.expense_categories
           (property_id, system_key, name, color, sort_order)
         VALUES ($1, 'staff', 'Staff', '#6366F1', 10)`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[1]!.query(
            "UPDATE finance.expense_categories SET name='Forged' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);

      expect(
        (
          await logins[0]!.query(
            "UPDATE finance.expense_categories SET name='Forged' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[1]!.query(
            "UPDATE pms.property_pricing_settings SET currency='EUR' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
            properties[0],
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        logins[0]!.query(
          `UPDATE identity.product_entitlements SET status='active',
         metadata='{"newHotelFinancialsDefault":"ready"}'
         WHERE resource_id=$1`,
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status)
         VALUES ($1, 'pms', 'property-management', 'active')`,
          [organizationId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[0]!.query(
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE lower(resource_id)=$1",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      await admin.query(`REVOKE vayada_next_hotel_setup_property_scope FROM ${roles[1]}`);
      expect(
        (
          await logins[1]!.query("SELECT id FROM hotel_catalog.properties WHERE id=$1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await expect(
        logins[1]!.query(
          `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Transfer locks the assignment, so a concurrent old-login write waits
      // and is rejected after the new owner and login become effective.
      await admin.query("BEGIN");
      transferOpen = true;
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[0]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[3]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[4]],
      );
      await admin.query(
        `UPDATE identity.organization_resource_links SET organization_id=$1
         WHERE organization_id=$2 AND resource_id=$3`,
        [organizations[1], organizationId, properties[0]!.toUpperCase()],
      );
      await admin.query(
        `UPDATE identity.product_entitlements SET organization_id=$1
         WHERE organization_id=$2 AND resource_id=$3`,
        [organizations[1], organizationId, properties[0]],
      );
      await admin.query(
        `INSERT INTO platform.hotel_setup_property_scopes
           (database_login, property_id, organization_id) VALUES ($1, $2, $3)`,
        [roles[2], properties[0], organizations[1]],
      );
      if (!inspectorConnected) {
        await inspector.connect();
        inspectorConnected = true;
      }
      const oldLoginPid = (
        await logins[0]!.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await logins[0]!.query("SET statement_timeout = '10s'");
      const oldWrite = logins[0]!.query(
        `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
        [properties[0]],
      );
      void oldWrite.catch(() => {});
      await expectBlocked(inspector, oldLoginPid);
      await admin.query("COMMIT");
      transferOpen = false;
      await expect(oldWrite).rejects.toMatchObject({ code: "42501" });
      await expect(
        withHotelSetupCommandScope(
          scopePool(logins[3]!),
          {
            propertyId: properties[0]!,
            organizationId,
            operation: "currency_ready",
          },
          async () => undefined,
        ),
      ).rejects.toThrow("scope preflight failed");
      expect(
        (
          await logins[3]!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_property_operation_allowed($1, 'currency_ready') AS allowed",
            [properties[0]],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (
          await logins[4]!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_property_operation_allowed($1, 'feature_hub') AS allowed",
            [properties[0]],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (
          await logins[0]!.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[2]!.query(
            "SELECT resource_id FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([{ resource_id: properties[0] }]);
      expect(
        (
          await logins[2]!.query(
            `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      if (transferOpen) await admin.query("ROLLBACK");
      if (inspectorConnected) await inspector.end();
      await Promise.all(logins.map((login) => login.end()));
      await admin.query(`DROP TABLE IF EXISTS public.${ownedRelation}`);
      // Only dedicated synthetic test databases reach this cleanup.
      await admin.query("BEGIN");
      for (const relation of ["product_audit_events", "domain_events"])
        await admin.query(
          `ALTER TABLE platform.${relation} DISABLE TRIGGER trg_platform_${relation}_append_only`,
        );
      for (const relation of [
        "product_audit_events",
        "outbox_events",
        "domain_events",
        "idempotency_keys",
      ])
        await admin.query(`DELETE FROM platform.${relation} WHERE property_id=ANY($1::uuid[])`, [
          properties,
        ]);
      for (const relation of ["product_audit_events", "domain_events"])
        await admin.query(
          `ALTER TABLE platform.${relation} ENABLE TRIGGER trg_platform_${relation}_append_only`,
        );
      await admin.query("COMMIT");
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=ANY($1::uuid[])",
        [organizations],
      );
      await admin.query(
        "DELETE FROM finance.expense_categories WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      for (const relation of [
        "pms.recurring_pricing_sources",
        "pms.rate_rules",
        "pms.rate_plans",
        "pms.room_types",
      ])
        await admin.query(`DELETE FROM ${relation} WHERE property_id=ANY($1::uuid[])`, [
          properties,
        ]);
      await admin.query(
        "DELETE FROM pms.property_pricing_settings WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=ANY($1::uuid[])",
        [organizations],
      );
      await admin.query(
        "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=ANY($1::name[])",
        [roles],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id=ANY($1::uuid[])",
        [organizations],
      );
      await admin.query("DELETE FROM identity.organization_roles WHERE id=$1", [roleDefinition]);
      await admin.query("DELETE FROM identity.users WHERE id=ANY($1::uuid[])", [users]);
      await admin.query(
        "DELETE FROM identity.role_permission_grants WHERE role_key=ANY($1::text[])",
        [roleKeys],
      );
      await admin.query("DELETE FROM identity.organizations WHERE id=ANY($1::uuid[])", [
        organizations,
      ]);
      for (const role of roles) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  }, 120_000);
});
