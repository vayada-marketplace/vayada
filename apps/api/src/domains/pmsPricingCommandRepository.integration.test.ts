import {
  parsePmsPricingCurrency,
  parseUpsertPropertyPricingCurrencyCommand,
  type PmsPricingCurrencyChangeBlocker,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./pmsPricingCommandRepository.js";
import { PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1 } from "./pmsPricingCurrencyCapabilities.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "16900000-0000-4000-8000-000000000001";
const organizationId = "16900000-0000-4000-8000-000000000002";
const propertyId = "16900000-0000-4000-8000-000000000003";
const roomTypeId = "16900000-0000-4000-8000-000000000004";
const planId = "16900000-0000-4000-8000-000000000006";
const acceptedAt = "2026-08-03T13:00:00.000Z";
const roleKey = "vay1069_pricing_integration";
const auditFailureFunction = "platform.vay1069_fail_pricing_audit";
const auditFailureTrigger = "trg_vay1069_fail_pricing_audit";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS pricing command repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let guardBlockers: readonly PmsPricingCurrencyChangeBlocker[] = [];
  let guardThrows = false;
  let mealSyncEnabled = false;
  let mealSyncPropertyId: string | undefined;
  const guardCalls: Array<{ currentCurrency: string; requestedCurrency: string }> = [];
  const repository = createPgPmsPricingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 6,
    get channexMealSyncEnabled() {
      return mealSyncEnabled;
    },
    get channexMealSyncPropertyId() {
      return mealSyncPropertyId;
    },
    now: () => new Date(acceptedAt),
    randomId: () => planId,
    currencyChangeGuard: {
      async runWithCurrencyChangeGuard(input, guarded) {
        guardCalls.push(input);
        if (guardThrows) throw new Error("dependency guard unavailable");
        return guarded(guardBlockers);
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
    guardBlockers = [];
    guardThrows = false;
    mealSyncEnabled = false;
    mealSyncPropertyId = undefined;
    guardCalls.length = 0;
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("rechecks authorization before replay and excludes front-desk scope", async () => {
    const command = currencyCommand("scope-replay", 0, "EUR");
    await expect(repository.upsertPropertyPricingCurrency(command)).resolves.toMatchObject({
      ok: true,
    });
    await admin.query(
      `UPDATE identity.organization_resource_links SET relationship = 'front_desk'
       WHERE organization_id = $1::uuid AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );

    await expect(repository.upsertPropertyPricingCurrency(command)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(eventCount()).resolves.toBe(1);
  });

  it("changes currency only inside the dependency guard and fails closed when blocked or unavailable", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-eur", 0, "EUR"));
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-usd", 1, "USD")),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        pricingCurrency: { currency: "USD", pricingCurrencyRevision: 2 },
      },
    });
    expect(guardCalls).toEqual([{ propertyId, currentCurrency: "EUR", requestedCurrency: "USD" }]);

    guardBlockers = [{ code: "payment_configuration", affectedCount: 1 }];
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-chf-blocked", 2, "CHF")),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 2,
        blockers: [{ code: "payment_configuration", affectedCount: 1 }],
      },
    });

    guardBlockers = [];
    guardThrows = true;
    await expect(
      repository.upsertPropertyPricingCurrency(
        currencyCommand("currency-chf-unavailable", 2, "CHF"),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 2,
        blockers: [{ code: "dependency_check_unavailable" }],
      },
    });
    await expect(readCurrency()).resolves.toEqual({ currency: "USD", revision: "2" });
    await expect(eventCount()).resolves.toBe(2);
  });

  it("blocks currency changes for active, disabled, and invalid recurring sources under the existing rate-rule code", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-eur", 0, "EUR"));
    await seedRoomType(roomTypeId, "Recurring-source blocker suite");
    await admin.query(
      `INSERT INTO pms.rate_rules (
         property_id, room_type_id, rule_type, starts_on, ends_on
       ) VALUES ($1::uuid, $2::uuid, 'daily_rate', DATE '2026-08-03', DATE '2026-08-03')`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         currency, source_pricing_currency_revision,
         season_name, season_start_month, season_start_day,
         season_end_month, season_end_day, weekend_days,
         discount_percent, cancellation_terms_type, refund_policy,
         no_show_penalty, payment_timing
       ) VALUES
       ('16900000-0000-4000-8000-000000000101', $1::uuid, 'season', 1, 'active',
        'valid', 1, $2::timestamptz, '[]'::jsonb, 'EUR', 1,
        'Summer', 6, 1, 9, 30, NULL, NULL, NULL, NULL, NULL, NULL),
       ('16900000-0000-4000-8000-000000000102', $1::uuid, 'weekend_surcharge', 1,
        'disabled', 'valid', 1, $2::timestamptz, '[]'::jsonb, 'EUR', 1,
        NULL, NULL, NULL, NULL, NULL, ARRAY['saturday'], NULL, NULL, NULL, NULL, NULL),
       ('16900000-0000-4000-8000-000000000103', $1::uuid, 'additional_guest', 1,
        'active', 'invalid', 1, $2::timestamptz,
        '[{"code":"dependency_unavailable"}]'::jsonb, 'EUR', 1,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
       ('16900000-0000-4000-8000-000000000104', $1::uuid, 'non_refundable', 1,
        'active', 'valid', 1, $2::timestamptz, '[]'::jsonb, 'EUR', 1,
        NULL, NULL, NULL, NULL, NULL, NULL,
        10, 'non_refundable', 'no_refund', 'full_booking_amount', 'prepay_full')`,
      [propertyId, acceptedAt],
    );

    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-usd", 1, "USD")),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 1,
        blockers: [{ code: "rate_rule", affectedCount: 5 }],
      },
    });
    await expect(readCurrency()).resolves.toEqual({ currency: "EUR", revision: "1" });
  });

  it("serializes a recurring-source write ahead of a currency change and returns a typed blocker", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-eur", 0, "EUR"));
    await admin.query("BEGIN");
    await admin.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(concat('pms-pricing-currency:', $1::uuid::text), 0)
       )`,
      [propertyId],
    );
    const currencyChange = repository.upsertPropertyPricingCurrency(
      currencyCommand("currency-usd-racing-source", 1, "USD"),
    );
    try {
      await waitForAdvisoryWaiters(1);
      await admin.query(
        `INSERT INTO pms.recurring_pricing_sources (
           id, property_id, source_kind, source_revision, configured_state,
           validation_state, validation_revision, validated_at, invalid_reasons,
           currency, source_pricing_currency_revision, discount_percent,
           cancellation_terms_type, refund_policy, no_show_penalty, payment_timing
         ) VALUES (
           '16900000-0000-4000-8000-000000000105', $1::uuid, 'non_refundable', 1,
           'active', 'valid', 1, $2::timestamptz, '[]'::jsonb, 'EUR', 1,
           10, 'non_refundable', 'no_refund', 'full_booking_amount', 'prepay_full'
         )`,
        [propertyId, acceptedAt],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([currencyChange]);
      throw error;
    }

    await expect(currencyChange).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 1,
        blockers: [{ code: "rate_rule", affectedCount: 1 }],
      },
    });
    await expect(readCurrency()).resolves.toEqual({ currency: "EUR", revision: "1" });
  });

  it("stores unsupported currency as a typed conflict without authoritative mutation", async () => {
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-unsupported", 0, "ZZZ")),
    ).resolves.toEqual({ ok: false, error: { code: "unsupported_pricing_currency" } });
    await expect(readCurrency()).resolves.toBeNull();
    await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(idempotencyCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(eventCount()).resolves.toBe(0);
    await expect(outboxCount()).resolves.toBe(0);
  });

  it("accepts every advertised pricing currency when other command inputs are valid", async () => {
    for (const currency of PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1) {
      await expect(
        repository.upsertPropertyPricingCurrency(
          currencyCommand(`currency-supported-${currency}`, 0, currency),
        ),
      ).resolves.toMatchObject({
        ok: true,
        response: {
          outcome: "created",
          pricingCurrency: { currency, pricingCurrencyRevision: 1 },
        },
      });
      await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
    }
  });

  it("rolls back pricing, event, outbox, audit, and idempotency when audit fails", async () => {
    await installAuditFailureTrigger();
    try {
      await expect(
        repository.upsertPropertyPricingCurrency(currencyCommand("currency-audit-fail", 0, "EUR")),
      ).rejects.toThrow("injected VAY-1069 audit failure");
      await expect(readCurrency()).resolves.toBeNull();
      await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(0);
      await expect(idempotencyCount("pms.pricing_currency.upsert")).resolves.toBe(0);
      await expect(eventCount()).resolves.toBe(0);
      await expect(outboxCount()).resolves.toBe(0);
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1069-pricing@example.test', 'VAY-1069 Pricing', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1069 Pricing', 'vay1069-pricing', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1069-pricing', 'VAY-1069 Pricing')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage')
       ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedRoomType(id: string, name: string): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, base_rate_amount, currency,
         active, room_facts_revision
       ) VALUES ($1::uuid, $2::uuid, $3, '', NULL, NULL, TRUE, 1)`,
      [id, propertyId, name],
    );
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION ${auditFailureFunction}()
       RETURNS trigger LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action = 'pms.pricing_currency.upsert' THEN
           RAISE EXCEPTION 'injected VAY-1069 audit failure';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    );
    await admin.query(
      `CREATE TRIGGER ${auditFailureTrigger}
       BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION ${auditFailureFunction}()`,
    );
  }

  async function removeAuditFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS ${auditFailureTrigger} ON platform.product_audit_events`,
    );
    await admin.query(`DROP FUNCTION IF EXISTS ${auditFailureFunction}()`);
  }

  async function cleanup(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM pms.recurring_pricing_materialized_rows WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_materialization_source_receipts WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_materialization_receipts WHERE property_id = $1::uuid",
        "DELETE FROM pms.non_refundable_rate_plan_source_rooms WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_source_room_values WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_sources WHERE property_id = $1::uuid",
        "DELETE FROM pms.rate_rules WHERE property_id = $1::uuid",
        "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)",
        "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
        "DELETE FROM pms.channel_connections WHERE property_id = $1::uuid",
        "DELETE FROM pms.channel_binding_claims WHERE property_id = $1::uuid",
        "DELETE FROM pms.rate_plans WHERE property_id = $1::uuid",
        "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
        "DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
      ]) {
        await admin.query(statement, [propertyId]);
      }
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await admin.query(
        `DELETE FROM identity.role_permission_grants
         WHERE organization_kind = 'hotel_group' AND role_key = $1`,
        [roleKey],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function readCurrency() {
    const result = await admin.query(
      `SELECT currency::text AS currency, pricing_currency_revision::text AS revision
       FROM pms.property_pricing_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  }

  async function auditCount(action: string): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.product_audit_events
       WHERE property_id = $1::uuid AND action = $2`,
      [propertyId, action],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function idempotencyCount(operation: string): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.idempotency_keys
       WHERE property_id = $1::uuid AND operation = $2 AND status = 'completed'`,
      [propertyId, operation],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function eventCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.domain_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function outboxCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND granted = FALSE
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent PMS pricing commands did not reach the advisory lock");
  }
});

function currencyCommand(key: string, expectedRevision: number, currencyCode: string) {
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId,
    propertyId,
    idempotencyKey: key,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      requestedAt: acceptedAt,
    },
    expectedPricingCurrencyRevision: expectedRevision,
    currency: parsePmsPricingCurrency(currencyCode),
  });
  if (!command) throw new Error("Invalid pricing currency command fixture");
  return command;
}

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!database.includes("test")) {
    throw new Error("Refusing to run PMS pricing integration against a non-test database");
  }
}
