import { randomUUID } from "node:crypto";

import {
  parsePmsPricingCurrency,
  parseUpsertPropertyPricingCurrencyCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import { PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD } from "./domains/pmsPricingCurrencyCapabilities.js";
import { createPricingGuestDisplayRateReader } from "./domains/pricingGuestDisplayRate.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  listOrdinaryPostureViolations,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ROLE_KEY = "vay2390_currency_change_owner";
const PREFIX = "vay-2390-change-";

// VAY-2390 P5: the Owner's protected currency change on the login that mirrors next-api's runtime
// posture. Finance's bound payment currency follows by the 0526 cascade, only for the changed hotel;
// every blocker refuses with nothing changed, and a failure part-way rolls everything back.
describe.skipIf(!TEST_DATABASE_URL)("Owner pricing currency change (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  const hotel = randomUUID();
  const otherHotel = randomUUID();
  const addonId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: ReturnType<typeof createPgPmsPricingCommandRepository>;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanup();
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgPmsPricingCommandRepository({
      connectionString: fixture.connectionString,
      currencyChangeGuard: PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD,
      ownerCurrencyChange: true,
      max: 2,
    });
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    try {
      await repository?.close();
      if (fixture) {
        await waitForSessionsToEnd(admin, fixture.login);
        await fixture.drop();
      }
      if (TEST_DATABASE_URL) await cleanup();
    } finally {
      await admin.end();
    }
  });

  // VAY-2395's lesson: FOR SHARE / FOR UPDATE need UPDATE on the locked table. The fixture carries the
  // platform runtime grant contract (grant-target-database-runtime-product-dml.mjs, #594); this pins
  // every table the change writes, locks or reads on that login.
  it("runs on the runtime grant contract: UPDATE wherever it writes or locks, SELECT where it counts", async () => {
    // The posture queries read the connected login's own privileges.
    const runtime = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    try {
      expect(await listOrdinaryPostureViolations(runtime)).toEqual([]);
    } finally {
      await runtime.end();
    }
    const tables = {
      "hotel_catalog.properties": ["SELECT", "UPDATE"],
      "pms.property_pricing_settings": ["SELECT", "UPDATE"],
      "finance.payment_settings": ["SELECT", "UPDATE"],
      "booking.addon_definitions": ["SELECT", "UPDATE"],
      "booking.booking_settings": ["SELECT", "UPDATE"],
      "booking.guest_bookings": ["SELECT"],
      "pms.channel_connections": ["SELECT"],
      "pms.channel_binding_claims": ["SELECT"],
      "finance.expenses": ["SELECT"],
      "finance.folio_revisions": ["SELECT"],
      "finance.recurring_expense_rules": ["SELECT"],
      "platform.product_audit_events": ["INSERT"],
    } as const;
    for (const [table, privileges] of Object.entries(tables)) {
      for (const privilege of privileges) {
        const granted = await admin.query<{ granted: boolean }>(
          "SELECT has_table_privilege($1, $2, $3) AS granted",
          [fixture.login, table, privilege],
        );
        expect({ table, privilege, granted: granted.rows[0]?.granted }).toEqual({
          table,
          privilege,
          granted: true,
        });
      }
    }
    // The identity rows the scope check locks FOR SHARE / FOR KEY SHARE need an UPDATE-able column too.
    for (const table of [
      "identity.organizations",
      "identity.users",
      "identity.organization_memberships",
      "identity.organization_resource_links",
      "identity.product_entitlements",
      "identity.role_permission_grants",
    ]) {
      const granted = await admin.query<{ granted: boolean }>(
        "SELECT has_any_column_privilege($1, $2, 'UPDATE') AS granted",
        [fixture.login, table],
      );
      expect({ table, granted: granted.rows[0]?.granted }).toEqual({ table, granted: true });
    }
  });

  it("moves Finance, add-ons and a matching Booking default to the new currency, numbers kept, for this hotel only", async () => {
    const otherBefore = await finance(otherHotel);
    const hotelBefore = await finance(hotel);
    // The dialog's preview finds nothing in the way either.
    await expect(repository.getCurrencyChangeBlockers(hotel)).resolves.toEqual([]);

    const result = await repository.upsertPropertyPricingCurrency(command("change", 1, "CHF"));

    expect(result).toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        pricingCurrency: { currency: "CHF", pricingCurrencyRevision: 2 },
      },
    });
    // The bound row moved although the explicit update skips bound rows: the cascade did it, in the
    // pricing row's own UPDATE statement. A new currency also retires old card readiness evidence.
    expect(await finance(hotel)).toMatchObject({
      default_currency: "CHF",
      source_pricing_currency_revision: "2",
      online_card_readiness_revision: String(
        Number(hotelBefore.online_card_readiness_revision) + 1,
      ),
    });
    expect(await finance(otherHotel)).toEqual(otherBefore);
    expect(
      (
        await admin.query(
          "SELECT currency::text, price_amount::text AS price FROM booking.addon_definitions WHERE id=$1",
          [addonId],
        )
      ).rows[0],
    ).toEqual({ currency: "CHF", price: "25.00" });
    expect(
      (
        await admin.query(
          "SELECT default_currency::text FROM booking.booking_settings WHERE property_id=$1",
          [hotel],
        )
      ).rows[0],
    ).toEqual({ default_currency: "CHF" });
  });

  it("keeps a Booking display default the Owner chose apart from the pricing currency", async () => {
    await admin.query(
      "UPDATE booking.booking_settings SET default_currency='USD' WHERE property_id=$1",
      [hotel],
    );
    await expect(
      repository.upsertPropertyPricingCurrency(command("display", 1, "CHF")),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(
      (
        await admin.query(
          "SELECT default_currency::text FROM booking.booking_settings WHERE property_id=$1",
          [hotel],
        )
      ).rows[0],
    ).toEqual({ default_currency: "USD" });
  });

  it.each([
    [
      "an upcoming booking",
      "booking_reference",
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,currency,total_amount,room_count,adults,children,booking_metadata)
       VALUES(gen_random_uuid(),$1,'${PREFIX}' || gen_random_uuid(),'booking_com','confirmed',CURRENT_DATE + 3,CURRENT_DATE + 5,'EUR',300,1,2,0,'{}')`,
    ],
    [
      "a channel connection still being set up",
      "channel_connection",
      "INSERT INTO pms.channel_connections(property_id,provider,connection_status) VALUES($1,'custom','setup_incomplete')",
    ],
    [
      "a Finance expense",
      "finance_record",
      `INSERT INTO finance.expenses(id,property_id,category_id,origin,entry_kind,incurred_on,vendor,amount,currency,payment_status)
       VALUES(gen_random_uuid(),$1,gen_random_uuid(),'manual','expense','2026-08-03','Laundry',10,'EUR','unpaid')`,
    ],
  ])("refuses while the hotel has %s, and changes nothing", async (_name, code, insert) => {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(insert, [hotel]);
    await admin.query("COMMIT");
    const before = await snapshot();
    // The dialog's preview names the same reason before the Owner types anything.
    await expect(repository.getCurrencyChangeBlockers(hotel)).resolves.toEqual([
      { code, affectedCount: 1 },
    ]);

    const result = await repository.upsertPropertyPricingCurrency(
      command(`blocked-${code}`, 1, "CHF"),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "pricing_currency_change_blocked", blockers: [{ code, affectedCount: 1 }] },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("waits for a booking writer holding the property, then sees what it wrote", async () => {
    const writer = await admin.connect();
    try {
      await writer.query("BEGIN");
      // A booking-page draft holds the property FOR UPDATE; this channel row holds it by its FK.
      await writer.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [hotel]);
      await writer.query(
        "INSERT INTO pms.channel_connections(property_id,provider,connection_status) VALUES($1,'custom','setup_incomplete')",
        [hotel],
      );
      const before = await snapshot();
      const change = repository.upsertPropertyPricingCurrency(command("racing", 1, "CHF"));
      await waitForLockWaiter(fixture.login);
      // The preview takes no locks: it answers at once, without the uncommitted channel.
      await expect(repository.getCurrencyChangeBlockers(hotel)).resolves.toEqual([]);
      await writer.query("COMMIT");

      await expect(change).resolves.toMatchObject({
        ok: false,
        error: { blockers: [{ code: "channel_connection", affectedCount: 1 }] },
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      writer.release();
    }
  });

  it("rolls the whole change back when a later step fails", async () => {
    const before = await snapshot();
    // The Booking default is the last row the change moves, after the pricing row and Finance.
    await admin.query(`CREATE OR REPLACE FUNCTION public.vay2390_fail_carry() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'injected VAY-2390 failure'; END $f$`);
    await admin.query(
      "CREATE TRIGGER vay2390_fail_carry BEFORE UPDATE ON booking.booking_settings FOR EACH ROW EXECUTE FUNCTION public.vay2390_fail_carry()",
    );
    try {
      await expect(
        repository.upsertPropertyPricingCurrency(command("failing", 1, "CHF")),
      ).rejects.toThrow(/injected VAY-2390 failure/);
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS vay2390_fail_carry ON booking.booking_settings");
      await admin.query("DROP FUNCTION IF EXISTS public.vay2390_fail_carry()");
    }
    // The pricing row, the cascaded Finance row and the add-on all kept their old currency.
    expect(await snapshot()).toEqual(before);
  });

  // VAY-2390: the Prices footer's "They see ≈ US$73 first" reads on the same login, SELECT only.
  it("reads the currency guests see first, and nothing while it is the pricing currency or the selector is off", async () => {
    const runtime = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    try {
      const guestDisplay = createPricingGuestDisplayRateReader({
        pool: runtime,
        displayRates: { rates: async () => ({ USD: 1.16 }) },
      });
      await expect(guestDisplay.read(hotel)).resolves.toBeNull();
      await admin.query(
        "UPDATE booking.booking_settings SET default_currency='USD' WHERE property_id=$1",
        [hotel],
      );
      await expect(guestDisplay.read(hotel)).resolves.toEqual({
        base: "EUR",
        currency: "USD",
        rate: 1.16,
      });
      await admin.query(
        "UPDATE booking.booking_settings SET show_currency_selector=false WHERE property_id=$1",
        [hotel],
      );
      await expect(guestDisplay.read(hotel)).resolves.toBeNull();
    } finally {
      await runtime.end();
    }
  });

  function command(key: string, expectedRevision: number, currency: string) {
    const parsed = parseUpsertPropertyPricingCurrencyCommand({
      organizationId,
      propertyId: hotel,
      idempotencyKey: `${PREFIX}${key}-${randomUUID()}`,
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: `request-${key}`,
        correlationId: `correlation-${key}`,
        requestedAt: new Date().toISOString(),
      },
      expectedPricingCurrencyRevision: expectedRevision,
      currency: parsePmsPricingCurrency(currency),
    });
    if (!parsed) throw new Error("Invalid currency change fixture");
    return parsed;
  }

  async function finance(property: string) {
    return (
      await admin.query(
        `SELECT default_currency::text, source_pricing_currency_revision::text,
                online_card_readiness_revision::text, updated_at
         FROM finance.payment_settings WHERE property_id=$1`,
        [property],
      )
    ).rows[0];
  }

  async function snapshot() {
    return (
      await admin.query(
        `SELECT
           (SELECT currency::text || ':' || pricing_currency_revision FROM pms.property_pricing_settings WHERE property_id=$1) AS pricing,
           (SELECT default_currency::text || ':' || source_pricing_currency_revision FROM finance.payment_settings WHERE property_id=$1) AS finance,
           (SELECT currency::text FROM booking.addon_definitions WHERE property_id=$1) AS addon,
           (SELECT default_currency::text FROM booking.booking_settings WHERE property_id=$1) AS display`,
        [hotel],
      )
    ).rows[0];
  }

  async function seed(): Promise<void> {
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2390 Owner', 'active')",
      [actorUserId, `${PREFIX}${actorUserId}@example.test`],
    );
    await admin.query(
      "INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1::uuid, 'hotel_group', 'VAY-2390', $2, 'active')",
      [organizationId, `${PREFIX}${organizationId}`],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, ROLE_KEY],
    );
    for (const permission of ["pms.operations.manage", "finance.billing.manage"]) {
      await admin.query(
        `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
         VALUES ('hotel_group', $1, $2) ON CONFLICT DO NOTHING`,
        [ROLE_KEY, permission],
      );
    }
    for (const property of [hotel, otherHotel]) {
      await admin.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $2, 'VAY-2390 hotel')",
        [property, `${PREFIX}${property}`],
      );
      await admin.query(
        `INSERT INTO pms.property_pricing_settings (property_id, currency, pricing_currency_revision)
         VALUES ($1::uuid, 'EUR', 1)`,
        [property],
      );
      await admin.query(
        `INSERT INTO finance.payment_settings
           (property_id, default_currency, payment_readiness_contract_version,
            payment_methods_revision, source_pricing_currency_revision)
         VALUES ($1::uuid, 'EUR', 'finance-payment-readiness.v1', 1, 1)`,
        [property],
      );
    }
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, hotel],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, hotel],
    );
    await admin.query(
      `INSERT INTO booking.addon_definitions (id, property_id, name, pricing_model, price_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'Breakfast basket', 'per_stay', 25, 'EUR')`,
      [addonId, hotel],
    );
    await admin.query(
      "INSERT INTO booking.booking_settings (property_id, default_currency) VALUES ($1::uuid, 'EUR')",
      [hotel],
    );
  }

  async function cleanup(): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const properties = [hotel, otherHotel];
      for (const statement of [
        "DELETE FROM booking.guest_bookings WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM finance.expenses WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM booking.addon_definitions WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM booking.booking_settings WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM finance.payment_settings WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.property_pricing_settings WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM identity.product_entitlements WHERE resource_id = ANY($1::text[])",
        "DELETE FROM identity.organization_resource_links WHERE resource_id = ANY($1::text[])",
        "DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])",
      ]) {
        await client.query(statement, [properties]);
      }
      await client.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
        [organizationId],
      );
      await client.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await client.query("DELETE FROM identity.users WHERE id = $1", [actorUserId]);
      await client.query("DELETE FROM identity.role_permission_grants WHERE role_key = $1", [
        ROLE_KEY,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function waitForLockWaiter(login: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
        [login],
      );
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The currency change never waited for the property lock");
  }
});

async function waitForSessionsToEnd(admin: pg.Pool, login: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ sessions: number }>(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename=$1",
      [login],
    );
    if ((result.rows[0]?.sessions ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test login sessions still open after 5s; not dropping the login");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error("Refusing to run the currency change suite against a non-test database");
  }
}
