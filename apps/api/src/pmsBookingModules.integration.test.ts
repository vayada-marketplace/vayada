import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import { readGuestModuleSwitches } from "./domains/bookingGuestModules.js";
import {
  createPgBookingModuleRepository,
  type BookingModuleRepository,
} from "./routes/pmsBookingModules.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2200-";

// VAY-2200: next-api switches Add-ons and Promos as `vayada_next_api_runtime`, so this suite runs
// the repository through the test login that mirrors that role's product-DML posture.
describe.skipIf(!TEST_DATABASE_URL)("Booking Engine module switches (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: BookingModuleRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-2200', 'active')`,
      [actorUserId, `vay-2200-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgBookingModuleRepository({ connectionString: fixture.connectionString });
  });

  afterAll(async () => {
    try {
      await repository?.close?.();
      if (fixture) {
        await waitForSessionsToEnd(admin, fixture.login);
        await fixture.drop();
      }
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanupFixtures(admin);
        await admin.query("DELETE FROM identity.users WHERE id=$1::uuid", [actorUserId]);
      }
    } finally {
      await admin.end();
    }
  });

  it("reads and updates the booking settings and only inserts into the audit sink", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'booking.booking_settings', 'SELECT') AS "select",
         has_column_privilege($1, 'booking.booking_settings', 'addons_enabled', 'UPDATE')
           AS "addOnsUpdate",
         has_column_privilege($1, 'booking.booking_settings', 'promo_codes_enabled', 'UPDATE')
           AS "promosUpdate",
         has_table_privilege($1, 'platform.product_audit_events', 'INSERT') AS "auditInsert",
         has_table_privilege($1, 'platform.product_audit_events', 'UPDATE') AS "auditUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({
      select: true,
      addOnsUpdate: true,
      promosUpdate: true,
      auditInsert: true,
      auditUpdate: false,
    });
  });

  it("starts on, switches each module with an audit row and leaves the settings revision alone", async () => {
    const propertyId = await seedProperty(admin, true);
    const before = await settingsRow(admin, propertyId);
    expect(before).toMatchObject({
      addonsEnabled: true,
      showAddonsStep: true,
      promoCodesEnabled: true,
    });
    expect(await repository.read(propertyId)).toEqual({
      "add-ons": true,
      promos: true,
      updatedAt: before.updatedAt.toISOString(),
    });

    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };
    const promosOff = await repository.update({
      propertyId,
      moduleId: "promos",
      isActive: false,
      audit,
    });
    expect(promosOff).toMatchObject({ moduleId: "promos", isActive: false });
    await repository.update({ propertyId, moduleId: "add-ons", isActive: false, audit });
    await repository.update({ propertyId, moduleId: "promos", isActive: true, audit });

    expect(await repository.read(propertyId)).toMatchObject({ "add-ons": false, promos: true });
    // The booking page publication hashes this row; a switch must not make a live page look edited.
    // The Add-ons page's own "show the step" choice is a separate column and stays as it was.
    expect(await settingsRow(admin, propertyId)).toEqual({
      ...before,
      addonsEnabled: false,
      promoCodesEnabled: true,
    });

    const audits = await admin.query(
      `SELECT product, action, actor_user_id::text AS "actorUserId", redacted_payload AS payload,
              audit_metadata->>'organizationId' AS "organizationId"
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual(
      [
        ["booking.feature_module.deactivated", "promos", false],
        ["booking.feature_module.deactivated", "add-ons", false],
        ["booking.feature_module.activated", "promos", true],
      ].map(([action, moduleId, isActive]) => ({
        product: "booking",
        action,
        actorUserId,
        payload: { moduleId, isActive },
        organizationId,
      })),
    );
  });

  it("gives guests the switches live, and both on before booking settings exist", async () => {
    const withSettings = await seedProperty(admin, true);
    const withoutSettings = await seedProperty(admin, false);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };

    expect(await readGuestModuleSwitches(admin, withoutSettings)).toEqual({
      addOns: true,
      promoCodes: true,
    });
    await repository.update({
      propertyId: withSettings,
      moduleId: "promos",
      isActive: false,
      audit,
    });
    expect(await readGuestModuleSwitches(admin, withSettings)).toEqual({
      addOns: true,
      promoCodes: false,
    });
  });

  it("switches nothing and audits nothing for a property without booking settings", async () => {
    const propertyId = await seedProperty(admin, false);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };

    expect(await repository.read(propertyId)).toBeNull();
    expect(
      await repository.update({ propertyId, moduleId: "add-ons", isActive: false, audit }),
    ).toBeNull();
    const audits = await admin.query(
      "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1::uuid",
      [propertyId],
    );
    expect(audits.rows[0]?.count).toBe(0);
  });
});

async function seedProperty(admin: pg.Pool, withSettings: boolean): Promise<string> {
  const propertyId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'Booking Modules')`,
    [propertyId, `${PUBLIC_ID_PREFIX}${propertyId}`],
  );
  // Rows written before 0484 never name the new columns; the defaults keep them on.
  if (withSettings)
    await admin.query(
      "INSERT INTO booking.booking_settings (property_id, updated_at) VALUES ($1::uuid, $2)",
      [propertyId, "2026-10-01T09:00:00.000Z"],
    );
  return propertyId;
}

async function settingsRow(admin: pg.Pool, propertyId: string) {
  const result = await admin.query<{
    addonsEnabled: boolean;
    showAddonsStep: boolean;
    promoCodesEnabled: boolean;
    updatedAt: Date;
  }>(
    `SELECT addons_enabled AS "addonsEnabled", show_addons_step AS "showAddonsStep",
            promo_codes_enabled AS "promoCodesEnabled",
            updated_at AS "updatedAt"
     FROM booking.booking_settings WHERE property_id=$1::uuid`,
    [propertyId],
  );
  return result.rows[0]!;
}

async function cleanupFixtures(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = await client.query<{ id: string }>(
      "SELECT id FROM hotel_catalog.properties WHERE public_id LIKE $1",
      [`${PUBLIC_ID_PREFIX}%`],
    );
    const ids = fixtures.rows.map(({ id }) => id);
    // Replica mode skips FK cascades too, so every referencing row is deleted explicitly.
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["platform.product_audit_events", "booking.booking_settings"])
      await client.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [ids]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// pg-pool resolves end() before its clients close; wait so dropping the login kills nothing live.
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
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
