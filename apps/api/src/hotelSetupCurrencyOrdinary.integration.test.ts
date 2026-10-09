import { randomUUID } from "node:crypto";
import { parseUpsertPropertyPricingCurrencyCommand } from "@vayada/domain-pms";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { lockHotelSetupOrdinaryPropertyScope } from "./hotelSetupOrdinaryScope.js";

const url = process.env.TEST_DATABASE_URL;
const denied = { ok: false, error: { code: "setup_scope_unavailable" } };

describe.skipIf(!url)("ordinary first currency and Financials default (VAY-2056)", () => {
  it("ports the native first-currency completion and Owner re-check to the ordinary login", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const repository = createPgPmsPricingCommandRepository({
      connectionString: fixture.connectionString,
      pool,
      hotelSetupOrdinaryOwner: true,
      currencyChangeGuard: {
        async runWithCurrencyChangeGuard() {
          throw new Error("a first currency never needs the change guard");
        },
      },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const [org, foreignOrg, owner] = [1, 2, 3].map(() => randomUUID());
    const [pending, plain, blocked] = [1, 2, 3].map(() => randomUUID());
    const command = (propertyId: string, key: string, organizationId = org, currency = "LKR") => {
      const parsed = parseUpsertPropertyPricingCurrencyCommand({
        organizationId,
        propertyId,
        currency,
        expectedPricingCurrencyRevision: 0,
        idempotencyKey: `${key}-${suffix}`,
        audit: {
          actor: { kind: "user", userId: owner },
          requestId: `${key}-${suffix}`,
          correlationId: null,
          requestedAt: new Date().toISOString(),
        },
      });
      if (!parsed) throw new Error("invalid currency fixture");
      return parsed;
    };
    const one = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows[0];
    const financials = (propertyId: string) =>
      one(
        `SELECT status, metadata->>'newHotelFinancialsDefault' AS state,
           metadata ? 'newHotelFinancialsActivationTransaction' AS sealed
         FROM identity.product_entitlements WHERE entitlement_key='module:financials' AND resource_id=$1`,
        [propertyId],
      );
    const count = async (sql: string, values: unknown[]) => Number((await one(sql, values)).n);
    try {
      for (const [id, slug] of [
        [org, `c${suffix}`],
        [foreignOrg, `z${suffix}`],
      ] as const)
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Currency fixture',$2)",
          [id, slug],
        );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        owner,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
         VALUES ('hotel_group','hotel_owner','pms.operations.manage') ON CONFLICT DO NOTHING`,
      );
      await admin.query(
        "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')",
        [org],
      );
      for (const property of [pending, plain, blocked]) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Currency fixture',$2)",
          [property, org],
        );
        await admin.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')",
          [org, property],
        );
        if (property !== plain)
          await admin.query(
            `INSERT INTO identity.product_entitlements
             (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id,metadata)
             VALUES ($1,'pms','module:financials','suspended','pms','pms_property',$2,'{"newHotelFinancialsDefault":"pending"}')`,
            [org, property],
          );
      }

      // A pending new hotel: seven categories, Financials ready and active, one linked audit.
      const created = await repository.upsertPropertyPricingCurrency(command(pending, "first"));
      expect(created).toMatchObject({ ok: true, response: { outcome: "created" } });
      expect(await repository.upsertPropertyPricingCurrency(command(pending, "first"))).toEqual(
        created,
      );
      expect(await financials(pending)).toEqual({ status: "active", state: "ready", sealed: true });
      expect(
        await count(
          "SELECT count(*) AS n FROM finance.expense_categories WHERE property_id=$1 AND archived_at IS NULL",
          [pending],
        ),
      ).toBe(7);
      const activation = await one(
        `SELECT activation.audit_key, activation.audit_metadata->>'sourceAuditId' AS source,
           source.id::text AS expected, source.audit_key AS source_key, activation.actor_user_id::text AS actor
         FROM platform.product_audit_events activation
         JOIN platform.product_audit_events source ON source.property_id=activation.property_id
           AND source.action='pms.pricing_currency.upsert'
         WHERE activation.property_id=$1 AND activation.action='pms.financials.default_activated'`,
        [pending],
      );
      expect(activation.source).toBe(activation.expected);
      expect(activation.audit_key).toBe(`${activation.source_key}.financials-default`);
      expect(activation.actor).toBe(owner);
      expect(
        await count(
          "SELECT count(*) AS n FROM platform.product_audit_events WHERE property_id=$1 AND action='pms.financials.default_activated'",
          [pending],
        ),
      ).toBe(1);

      // An existing hotel without a pending default only saves its currency.
      expect(await repository.upsertPropertyPricingCurrency(command(plain, "plain"))).toMatchObject(
        {
          ok: true,
          response: { outcome: "created" },
        },
      );
      expect(await financials(plain)).toBeUndefined();
      expect(
        await count("SELECT count(*) AS n FROM finance.expense_categories WHERE property_id=$1", [
          plain,
        ]),
      ).toBe(0);

      // A suspended base entitlement is refused by the Owner re-check before any write.
      const veto = await one(
        `INSERT INTO identity.product_entitlements
         (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
         VALUES ($1,'pms','account_access','suspended','pms','pms_property',$2) RETURNING id`,
        [org, blocked],
      );
      expect(await repository.upsertPropertyPricingCurrency(command(blocked, "veto"))).toEqual(
        denied,
      );
      await admin.query("DELETE FROM identity.product_entitlements WHERE id=$1", [veto.id]);
      // A pending default whose own prerequisite fails aborts the whole save, as the native trigger.
      await admin.query(
        "UPDATE identity.product_entitlements SET starts_at=now()+interval '1 day' WHERE entitlement_key='module:financials' AND resource_id=$1",
        [blocked],
      );
      expect(await repository.upsertPropertyPricingCurrency(command(blocked, "blocked"))).toEqual(
        denied,
      );
      expect(
        await count(
          "SELECT count(*) AS n FROM pms.property_pricing_settings WHERE property_id=$1",
          [blocked],
        ),
      ).toBe(0);
      expect(await financials(blocked)).toEqual({
        status: "suspended",
        state: "pending",
        sealed: false,
      });

      // Foreign organization, suspended PMS link, permission override, PMS access off and a
      // suspended actor all deny before any write.
      expect(
        await repository.upsertPropertyPricingCurrency(command(blocked, "foreign", foreignOrg)),
      ).toEqual(denied);
      for (const [revoke, restore, id] of [
        [
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE product='pms' AND resource_id=$1::text",
          "UPDATE identity.organization_resource_links SET status='active' WHERE product='pms' AND resource_id=$1::text",
          blocked,
        ],
        [
          `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["pms.operations.manage"]}' WHERE user_id=$1`,
          "UPDATE identity.organization_memberships SET permission_overrides=NULL WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.organization_memberships SET pms_access_enabled=FALSE WHERE user_id=$1",
          "UPDATE identity.organization_memberships SET pms_access_enabled=TRUE WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.users SET status='suspended' WHERE id=$1",
          "UPDATE identity.users SET status='active' WHERE id=$1",
          owner,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        expect(await repository.upsertPropertyPricingCurrency(command(blocked, "revoked"))).toEqual(
          denied,
        );
        await admin.query(restore, [id]);
      }
    } finally {
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);

  // Ported from the retired native Financials scope suite: routing a hidden entitlement into
  // scope (0447 trigger, FOR KEY SHARE on the organization) serializes with the scope's
  // organization FOR UPDATE in both orders, even when organization_id does not change.
  it("serializes an entitlement retarget into scope with the ordinary scope locks", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    const writer = new pg.Client({ connectionString: url });
    await admin.connect();
    await writer.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const setup = new pg.Client({ connectionString: fixture.connectionString });
    await setup.connect();
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const repository = createPgPmsPricingCommandRepository({
      connectionString: fixture.connectionString,
      pool,
      hotelSetupOrdinaryOwner: true,
      currencyChangeGuard: {
        async runWithCurrencyChangeGuard() {
          throw new Error("a first currency never needs the change guard");
        },
      },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const [org, foreignOrg, owner, target, other] = [1, 2, 3, 4, 5].map(() => randomUUID());
    const command = (key: string) => {
      const parsed = parseUpsertPropertyPricingCurrencyCommand({
        organizationId: org,
        propertyId: target,
        currency: "LKR",
        expectedPricingCurrencyRevision: 0,
        idempotencyKey: `${key}-${suffix}`,
        audit: {
          actor: { kind: "user", userId: owner },
          requestId: `${key}-${suffix}`,
          correlationId: null,
          requestedAt: new Date().toISOString(),
        },
      });
      if (!parsed) throw new Error("invalid currency fixture");
      return parsed;
    };
    const expectBlocked = async (sql: string, values: unknown[]) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await admin.query(sql, values)).rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected a transaction to wait on a lock");
    };
    const retargetSql = `UPDATE identity.product_entitlements SET
      organization_id=$1,product='pms',entitlement_key=$2,
      resource_product=CASE WHEN $3::text IS NULL THEN NULL ELSE 'pms' END,
      resource_type=CASE WHEN $3::text IS NULL THEN NULL ELSE 'pms_property' END,
      resource_id=$3 WHERE id=$4`;
    try {
      for (const [id, slug] of [
        [org, `r${suffix}`],
        [foreignOrg, `q${suffix}`],
      ] as const)
        await admin.query(
          "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Retarget fixture',$2)",
          [id, slug],
        );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        owner,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
         VALUES ('hotel_group','hotel_owner','pms.operations.manage') ON CONFLICT DO NOTHING`,
      );
      await admin.query(
        "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')",
        [org],
      );
      for (const property of [target, other]) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Retarget fixture',$2)",
          [property, org],
        );
        await admin.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')",
          [org, property],
        );
      }
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const scopeCommand = command("scope");
      for (const [sourceOrganization, sourceProduct, sourceKey, sourceProperty, targetKey] of [
        [org, "pms", "unrelated", null, "pms-core"],
        [org, "marketplace", "account_access", null, "account_access"],
        [org, "pms", "property-management", other, "property-management"],
        [foreignOrg, "pms", "account_access", null, "account_access"],
      ] as const) {
        const entitlementId = randomUUID();
        const targetProperty = sourceProperty === null ? null : target.toUpperCase();
        const restore = () =>
          admin.query(
            `UPDATE identity.product_entitlements SET organization_id=$1,product=$2,
             entitlement_key=$3,resource_product=CASE WHEN $4::text IS NULL THEN NULL ELSE 'pms' END,
             resource_type=CASE WHEN $4::text IS NULL THEN NULL ELSE 'pms_property' END,
             resource_id=$4 WHERE id=$5`,
            [sourceOrganization, sourceProduct, sourceKey, sourceProperty, entitlementId],
          );
        await admin.query(
          `INSERT INTO identity.product_entitlements
           (id,organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
           VALUES ($1,$2,$3,$4,'suspended',CASE WHEN $5::text IS NULL THEN NULL ELSE 'pms' END,
             CASE WHEN $5::text IS NULL THEN NULL ELSE 'pms_property' END,$5)`,
          [entitlementId, sourceOrganization, sourceProduct, sourceKey, sourceProperty],
        );
        let setupOpen = false;
        let writerOpen = false;
        try {
          // Setup wins: the hidden row cannot move into scope until the setup commits.
          await setup.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          setupOpen = true;
          expect(
            await lockHotelSetupOrdinaryPropertyScope(setup, {
              propertyId: target,
              organizationId: org,
            }),
          ).toBe(true);
          expect(await lockHotelSetupCurrencyMembership(setup, scopeCommand)).toBe(true);
          const retarget = writer.query(retargetSql, [
            org,
            targetKey,
            targetProperty,
            entitlementId,
          ]);
          void retarget.catch(() => {});
          await expectBlocked(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
            [writerPid],
          );
          expect(await lockHotelSetupCurrencyMembership(setup, scopeCommand)).toBe(true);
          await setup.query("COMMIT");
          setupOpen = false;
          await retarget;
          expect(await repository.upsertPropertyPricingCurrency(command("after"))).toEqual(denied);
          await restore();

          // Retarget wins: the save waits on the organization lock, then refuses.
          await writer.query("BEGIN");
          writerOpen = true;
          await writer.query(retargetSql, [org, targetKey, targetProperty, entitlementId]);
          const deniedSave = repository.upsertPropertyPricingCurrency(command("during"));
          void deniedSave.catch(() => {});
          await expectBlocked(
            "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
            [fixture.login],
          );
          await writer.query("COMMIT");
          writerOpen = false;
          expect(await deniedSave).toEqual(denied);
        } finally {
          if (setupOpen) await setup.query("ROLLBACK");
          if (writerOpen) await writer.query("ROLLBACK");
          await admin.query("DELETE FROM identity.product_entitlements WHERE id=$1", [
            entitlementId,
          ]);
        }
      }
      // With every retargeted row gone the same Owner saves, so each refusal above was the row.
      expect(await repository.upsertPropertyPricingCurrency(command("final"))).toMatchObject({
        ok: true,
        response: { outcome: "created" },
      });
    } finally {
      await pool.end();
      await setup.end();
      await writer.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
