import { randomUUID } from "node:crypto";

import {
  parseReplaceFinancePaymentMethodsCommand,
  type FinancePaymentReadinessMethod,
  type FinanceRoutePaymentMethod,
} from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";
import { createFinanceBookingLaunchEvidenceAdapter } from "./financeBookingLaunchEvidence.js";
import { createPgFinancePaymentReadinessCommandRepository } from "./financePaymentReadinessCommandRepository.js";
import { createPgFinancePaymentReadinessReadModel } from "./financePaymentReadinessReadModel.js";
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
  const launch = createFinanceBookingLaunchEvidenceAdapter({ financeReadPort: readiness });

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
      paymentMethodsRevision: 1,
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
    await expect(saveSetup(1, ["pay_at_property", "card"])).resolves.toMatchObject({
      ok: true,
      response: { paymentReadiness: { paymentMethodsRevision: 2 } },
    });
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

  function saveSettingsPage(acceptedMethods: FinanceRoutePaymentMethod[]) {
    return settingsPage.updatePaymentSettings!({
      commandType: "finance.payment_settings.update",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: randomUUID(),
        reason: "VAY-2136 settings page save",
        requestedAt: acceptedAt,
      },
      payload: {
        paymentsEnabled: true,
        acceptedMethods,
        ...(acceptedMethods.includes("paypal")
          ? { depositPolicy: { paypalEmail: "pay@example.test" } }
          : {}),
      },
    });
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
