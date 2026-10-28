import { randomUUID } from "node:crypto";

import {
  parseReplaceFinancePaymentMethodsCommand,
  type FinancePaymentReadinessMethod,
  type FinancePaymentSettingsPatchPayload,
  type FinanceRoutePaymentMethod,
} from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";
import { createFinanceBookingLaunchEvidenceAdapter } from "./financeBookingLaunchEvidence.js";
import { createPgFinancePaymentReadinessCommandRepository } from "./financePaymentReadinessCommandRepository.js";
import { createPgFinancePaymentReadinessReadModel } from "./financePaymentReadinessReadModel.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { createPgPmsPricingReadModel } from "./pmsPricingReadModel.js";

// VAY-2136: the settings page (PATCH payment-settings) and the setup Payments step
// (PUT payment-methods) write the same finance.payment_settings row.
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "21360000-0000-4000-8000-000000000001";
const organizationId = "21360000-0000-4000-8000-000000000002";
const propertyId = "21360000-0000-4000-8000-000000000003";
const acceptedAt = "2026-10-12T10:00:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Finance payment-method writers", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const pool = new pg.Pool({ connectionString, max: 4 });
  const pricingReadPort = createPgPmsPricingReadModel({ connectionString, pool });
  const setup = createPgFinancePaymentReadinessCommandRepository({
    connectionString,
    max: 2,
    now: () => new Date(acceptedAt),
    pricingReadPort,
  });
  const settingsPage = createTargetFinancePropertySettingsRepository({ connectionString, pool });
  const readiness = createPgFinancePaymentReadinessReadModel({
    connectionString,
    pool,
    pricingReadPort,
  });
  // These cases are about payment methods; the hotel already has a billing plan.
  const launch = createFinanceBookingLaunchEvidenceAdapter({
    financeReadPort: readiness,
    billingPlan: { getBillingConfig: async () => ({}) as never },
  });

  beforeAll(() => assertSafeTestDatabase(connectionString));

  beforeEach(async () => {
    await cleanup();
    await seedScope();
  });

  afterAll(async () => {
    await setup.close();
    await cleanup();
    await pool.end();
  });

  it("reads and re-saves setup after the settings page saved its own method names", async () => {
    await expect(saveSetup(0, ["pay_at_property"])).resolves.toMatchObject({ ok: true });
    await expect(
      saveSettingsPage(["pay_at_property", "cash", "manual_card", "paypal"]),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      readiness.getPaymentReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      paymentMethodsRevision: 2,
      bookingPaymentReady: true,
      methods: [
        { method: "pay_at_property", selected: true, readiness: "ready" },
        { method: "card", selected: false },
        { method: "bank_transfer", selected: false },
      ],
    });
    await expect(
      launch.getBookingLaunchEvidence({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      outcome: "evidence",
      entities: [{ groupId: "booking.payments", blockers: [] }],
    });
    await expect(saveSetup(2, ["pay_at_property", "card"])).resolves.toMatchObject({
      ok: true,
      response: { paymentReadiness: { paymentMethodsRevision: 3 } },
    });
  });

  it("binds a settings-page save like the setup step, which can then save on top", async () => {
    await expect(saveSettingsPage(["pay_at_property", "cash"])).resolves.toMatchObject({
      ok: true,
      commandMeta: { outboxEvents: ["finance.payment_readiness.changed"] },
    });
    await expect(binding()).resolves.toEqual({
      contractVersion: "finance-payment-readiness.v1",
      revision: 1,
      pricingRevision: 7,
    });
    await expect(
      readiness.getPaymentReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({ paymentMethodsRevision: 1, bookingPaymentReady: true });
    await expect(
      launch.getBookingLaunchEvidence({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      outcome: "evidence",
      entities: [{ groupId: "booking.payments", blockers: [] }],
    });
    await expect(changeEvents()).resolves.toEqual([
      { outcome: "readiness_gained", revision: 1, outbox: 1 },
    ]);

    await expect(saveSetup(1, ["pay_at_property", "card"])).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", paymentReadiness: { paymentMethodsRevision: 2 } },
    });
  });

  it("keeps the revision and saved prices for replays and saves that keep the methods", async () => {
    const idempotencyKey = randomUUID();
    const methods: FinanceRoutePaymentMethod[] = ["pay_at_property", "cash", "paypal"];
    await expect(saveSettingsPage(methods, { idempotencyKey })).resolves.toMatchObject({
      ok: true,
      status: "updated",
    });
    const source = await pricingSource();

    await expect(saveSettingsPage(methods, { idempotencyKey })).resolves.toMatchObject({
      ok: true,
      status: "idempotent_replay",
    });
    await expect(pricingSource()).resolves.toBe(source);
    await saveSettingsPage(methods, { paypalEmail: "new-pay@example.test" });
    await expect(binding()).resolves.toMatchObject({ revision: 1 });

    const unchangedMethods = await pricingSource();
    await saveSettingsPage(["pay_at_property", "manual_card"]);
    await expect(binding()).resolves.toMatchObject({ revision: 2 });
    await expect(pricingSource()).resolves.not.toBe(unchangedMethods);
    await expect(changeEvents()).resolves.toEqual([
      { outcome: "readiness_gained", revision: 1, outbox: 1 },
      { outcome: "selection_changed", revision: 2, outbox: 1 },
    ]);
  });

  it("binds a row the old settings page left without a revision on its next save", async () => {
    await pool.query(
      `INSERT INTO finance.payment_settings
         (property_id, payments_enabled, accepted_methods, default_currency)
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash'], 'EUR')`,
      [propertyId],
    );
    await expect(readiness.getPaymentReadiness({ organizationId, propertyId })).resolves.toBe(null);

    await expect(saveSettingsPage(["pay_at_property", "cash"])).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      readiness.getPaymentReadiness({ organizationId, propertyId }),
    ).resolves.toMatchObject({ paymentMethodsRevision: 1, bookingPaymentReady: true });
  });

  it("saves without a revision when prices have no currency yet, and setup binds it later", async () => {
    await pool.query("DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid", [
      propertyId,
    ]);
    await expect(saveSettingsPage(["pay_at_property", "cash"])).resolves.toMatchObject({
      ok: true,
    });
    await expect(binding()).resolves.toEqual({
      contractVersion: null,
      revision: null,
      pricingRevision: null,
    });
    await expect(changeEvents()).resolves.toEqual([]);

    await seedPricingCurrency();
    await expect(saveSetup(0, ["pay_at_property"])).resolves.toMatchObject({
      ok: true,
      response: { outcome: "created", paymentReadiness: { paymentMethodsRevision: 1 } },
    });
  });

  it("keeps the row as is when the same methods arrive in another order", async () => {
    await saveSettingsPage(["pay_at_property", "cash", "manual_card"]);
    const before = await rowState();

    await expect(
      saveSettingsPage(["manual_card", "pay_at_property", "cash"]),
    ).resolves.toMatchObject({ ok: true, commandMeta: { outboxEvents: [] } });
    await expect(rowState()).resolves.toEqual(before);
  });

  // VAY-2390: Booking settings' default currency is only what guests see first.
  it("saves and binds in the price currency while booking settings show another one", async () => {
    await pool.query(
      `INSERT INTO booking.booking_settings (
         property_id, default_currency, default_language, supported_languages, acceptance_mode
       ) VALUES ($1::uuid, 'USD', 'en', ARRAY['en'], 'instant')`,
      [propertyId],
    );
    await expect(saveSettingsPage(["pay_at_property", "cash"])).resolves.toMatchObject({
      ok: true,
      settings: { defaultCurrency: "EUR" },
    });
    await expect(binding()).resolves.toEqual({
      contractVersion: "finance-payment-readiness.v1",
      revision: 1,
      pricingRevision: 7,
    });

    await expect(saveSetup(1, ["pay_at_property"])).resolves.toMatchObject({ ok: true });
    await expect(saveSettingsPage(["pay_at_property", "cash"])).resolves.toMatchObject({
      ok: true,
      settings: { defaultCurrency: "EUR" },
    });
    await expect(binding()).resolves.toMatchObject({ revision: 3 });
    await expect(
      saveSettingsPage([], {
        payload: { paymentsEnabled: true, acceptedMethods: ["cash"], defaultCurrency: "USD" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 409,
      code: "property_currency_conflict",
      message: "Payment currency changed to EUR. Reload before saving.",
    });
  });

  it("keeps PayPal and the pay-at-hotel choice when the setup step saves", async () => {
    await saveSettingsPage(["pay_at_property", "manual_card", "paypal"]);
    await expect(saveSetup(1, ["pay_at_property", "card"])).resolves.toMatchObject({
      ok: true,
      response: { paymentReadiness: { paymentMethodsRevision: 2, selectedMethodCount: 2 } },
    });
    await expect(settingsPage.getPaymentSettings(propertyId)).resolves.toMatchObject({
      paymentsEnabled: true,
      acceptedMethods: ["pay_at_property", "card", "manual_card", "paypal"],
      depositPolicy: { paypalEmail: "pay@example.test" },
    });

    await expect(saveSetup(2, ["card"])).resolves.toMatchObject({ ok: true });
    await expect(settingsPage.getPaymentSettings(propertyId)).resolves.toMatchObject({
      acceptedMethods: ["card", "paypal"],
    });
  });

  it("doesn't switch on extras an older disabled or malformed row still lists", async () => {
    for (const [enabled, methods] of [
      [false, ["paypal", "bank_transfer"]],
      [true, ["cash", "cash"]],
    ] as const) {
      await pool.query("DELETE FROM finance.payment_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await pool.query(
        `INSERT INTO finance.payment_settings
           (property_id, payments_enabled, accepted_methods, default_currency)
         VALUES ($1::uuid, $2, $3::text[], 'EUR')`,
        [propertyId, enabled, methods],
      );
      await expect(saveSetup(0, ["pay_at_property"])).resolves.toMatchObject({ ok: true });
      await expect(settingsPage.getPaymentSettings(propertyId)).resolves.toMatchObject({
        paymentsEnabled: true,
        acceptedMethods: ["pay_at_property"],
      });
    }
  });

  it("lets the settings page save other fields after setup chose plain pay at hotel", async () => {
    await saveSetup(0, ["pay_at_property"]);
    await expect(
      saveSettingsPage([], { payload: { requiresManualReview: true } }),
    ).resolves.toMatchObject({ ok: true, settings: { acceptedMethods: ["pay_at_property"] } });
    await expect(binding()).resolves.toMatchObject({ revision: 1 });
  });

  function saveSetup(expectedRevision: number, selectedMethods: FinancePaymentReadinessMethod[]) {
    const command = parseReplaceFinancePaymentMethodsCommand({
      organizationId,
      propertyId,
      idempotencyKey: randomUUID(),
      expectedPaymentMethodsRevision: expectedRevision,
      expectedPricingCurrencyRevision: 7,
      selectedMethods,
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: randomUUID(),
        correlationId: null,
        requestedAt: acceptedAt,
      },
    });
    if (!command) throw new Error("Invalid VAY-2136 setup command");
    return setup.replacePaymentMethods({ command, currentPricing: null });
  }

  function saveSettingsPage(
    acceptedMethods: FinanceRoutePaymentMethod[],
    options: {
      idempotencyKey?: string;
      paypalEmail?: string;
      payload?: FinancePaymentSettingsPatchPayload;
    } = {},
  ) {
    return settingsPage.updatePaymentSettings!({
      commandType: "finance.payment_settings.update",
      commandId: randomUUID(),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      propertyId,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: randomUUID(),
        reason: "VAY-2136 settings page save",
        requestedAt: acceptedAt,
      },
      payload: options.payload ?? {
        paymentsEnabled: true,
        acceptedMethods,
        ...(acceptedMethods.includes("paypal")
          ? { depositPolicy: { paypalEmail: options.paypalEmail ?? "pay@example.test" } }
          : {}),
      },
    });
  }

  async function binding() {
    const result = await pool.query<{
      contractVersion: string | null;
      revision: number | null;
      pricingRevision: number | null;
    }>(
      `SELECT payment_readiness_contract_version AS "contractVersion",
              payment_methods_revision::int AS revision,
              source_pricing_currency_revision::int AS "pricingRevision"
       FROM finance.payment_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  }

  /** Every column the saved-prices fingerprint and online-card evidence depend on. */
  async function rowState() {
    const result = await pool.query(
      `SELECT to_jsonb(settings) - 'updated_at' - 'created_at' AS state
       FROM finance.payment_settings settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]?.state ?? null;
  }

  async function changeEvents() {
    const result = await pool.query<{ outcome: string; revision: number; outbox: number }>(
      `SELECT event.payload ->> 'outcome' AS outcome,
              (event.payload ->> 'paymentMethodsRevision')::int AS revision,
              (SELECT count(*)::int FROM platform.outbox_events outbox
               WHERE outbox.domain_event_id = event.id
                 AND outbox.destination = 'booking.payment-source') AS outbox
       FROM platform.domain_events event
       WHERE event.property_id = $1::uuid
         AND event.event_type = 'finance.payment_readiness.changed'
       ORDER BY revision`,
      [propertyId],
    );
    return result.rows;
  }

  /** The Finance fingerprint saved prices are checked against ("Save prices again"). */
  async function pricingSource() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockFinanceReplacementPricingSource(client, propertyId);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function seedScope(): Promise<void> {
    await pool.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay2136@example.test', 'VAY-2136', 'active')`,
      [actorUserId],
    );
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2136', 'vay2136', 'active')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay2136', 'VAY-2136')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', 'owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await pool.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await pool.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
    await seedPricingCurrency();
  }

  async function seedPricingCurrency(): Promise<void> {
    await pool.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 7)`,
      [propertyId],
    );
  }

  async function cleanup(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
        "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
        "DELETE FROM finance.payment_provider_accounts WHERE property_id = $1::uuid",
        "DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
        "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
      ]) {
        await client.query(statement, [propertyId]);
      }
      for (const statement of [
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organizations WHERE id = $1::uuid",
      ]) {
        await client.query(statement, [organizationId]);
      }
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run Finance payment-writer integration tests on a non-test DB");
  }
}
