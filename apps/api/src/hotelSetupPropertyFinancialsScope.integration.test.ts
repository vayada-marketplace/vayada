import { randomUUID } from "node:crypto";

import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { seedPendingHotelFinancialsCategories } from "./domains/financeStarterCategories.js";
import { withHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

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
        : `vayada_next_hotel_setup_property_${index}_${suffix}`,
    );
    const passwords = roles.map(() => randomUUID());
    const organizations = [randomUUID(), randomUUID()];
    const organizationId = organizations[0]!;
    const users = [randomUUID(), randomUUID()];
    const roleKeys = [`lock_owner_${suffix}`, `lock_other_${suffix}`];
    const properties = [randomUUID(), randomUUID()];
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
        for (const relation of [
          "hotel_catalog.properties",
          "identity.organization_resource_links",
          "identity.product_entitlements",
          "identity.organizations",
          "identity.users",
          "identity.organization_memberships",
          "identity.role_permission_grants",
          "pms.property_pricing_settings",
          "finance.expense_categories",
          "platform.idempotency_keys",
          "platform.domain_events",
          "platform.outbox_events",
          "platform.product_audit_events",
        ]) {
          await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${relation} TO ${role}`);
        }
        await admin.query(`GRANT SELECT ON pms.room_types, pms.rate_plans TO ${role}`);
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
          "INSERT INTO identity.organization_memberships (organization_id,user_id,role_key,access_origin) VALUES ($1,$2,$3,'agency')",
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
      const repository = createPgPmsPricingCommandRepository({
        connectionString: url,
        pool: scopePool(logins[1]!),
        hotelSetupCurrencyOperation: "currency",
        currencyChangeGuard: {
          async runWithCurrencyChangeGuard() {
            throw new Error("initial currency does not need the change guard");
          },
        },
      });
      const created = await repository.upsertPropertyPricingCurrency(command);
      expect(created).toMatchObject({ ok: true, response: { outcome: "created" } });
      expect(await repository.upsertPropertyPricingCurrency(command)).toEqual(created);
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
      await inspector.connect();
      inspectorConnected = true;
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
  });
});
