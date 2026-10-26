import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgPmsCheckinSettingsRepository,
  DEFAULT_PMS_CHECKIN_SETTINGS,
  type PmsCheckinSettingsRepository,
} from "./routes/pmsCheckinSettings.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2374-";

// VAY-2374: next-api reads and writes Settings → Check-in as `vayada_next_api_runtime`, so this suite runs
// the repository through the test login that mirrors that role's product-DML posture (migration 0517).
describe.skipIf(!TEST_DATABASE_URL)("PMS check-in settings (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: PmsCheckinSettingsRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2374', 'active')`,
      [actorUserId, `vay-2374-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgPmsCheckinSettingsRepository({
      connectionString: fixture.connectionString,
    });
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

  const audit = () => ({
    actorUserId,
    organizationId,
    requestId: randomUUID(),
    correlationId: null,
  });

  it("has ordinary DML on the settings table", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'pms.checkin_settings', 'SELECT') AS "select",
         has_table_privilege($1, 'pms.checkin_settings', 'INSERT') AS "insert",
         has_table_privilege($1, 'pms.checkin_settings', 'UPDATE') AS "update"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({ select: true, insert: true, update: true });
  });

  it("reads the defaults, then saves, reads back and audits which settings changed", async () => {
    const propertyId = await seedProperty(admin);
    const addonId = await seedAddon(admin, propertyId, "active");
    expect(await repository.find(propertyId)).toEqual({
      settings: DEFAULT_PMS_CHECKIN_SETTINGS,
      updatedAt: null,
    });

    const settings = {
      ...DEFAULT_PMS_CHECKIN_SETTINGS,
      addonIds: [addonId],
      keyHandover: "none" as const,
    };
    const saved = await repository.save({ propertyId, settings, audit: audit() });
    expect(saved).toMatchObject({ ok: true, settings });
    expect(await repository.find(propertyId)).toEqual({
      settings,
      updatedAt: expect.any(String),
    });
    await repository.save({
      propertyId,
      settings: { ...settings, registrationScope: "all" },
      audit: audit(),
    });

    const audits = await admin.query(
      `SELECT action, actor_user_id::text AS "actorUserId", redacted_payload AS payload
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual([
      {
        action: "pms.checkin_settings.saved",
        actorUserId,
        payload: { changedSettings: ["addonIds", "keyHandover"] },
      },
      {
        action: "pms.checkin_settings.saved",
        actorUserId,
        payload: { changedSettings: ["registrationScope"] },
      },
    ]);
  });

  it("refuses add-ons of another property or retired ones", async () => {
    const propertyId = await seedProperty(admin);
    const otherPropertyId = await seedProperty(admin);
    const foreign = await seedAddon(admin, otherPropertyId, "active");
    const retired = await seedAddon(admin, propertyId, "retired");
    for (const addonId of [foreign, retired]) {
      const result = await repository.save({
        propertyId,
        settings: { ...DEFAULT_PMS_CHECKIN_SETTINGS, addonIds: [addonId] },
        audit: audit(),
      });
      expect(result).toEqual({ ok: false, code: "unknown_addon" });
    }
    expect((await repository.find(propertyId)).updatedAt).toBeNull();
  });
});

async function seedProperty(admin: pg.Pool): Promise<string> {
  const propertyId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'Check-in Settings')`,
    [propertyId, `${PUBLIC_ID_PREFIX}${propertyId}`],
  );
  return propertyId;
}

async function seedAddon(admin: pg.Pool, propertyId: string, status: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    `INSERT INTO booking.addon_definitions (property_id, name, pricing_model, price_amount, currency, status)
     VALUES ($1::uuid, 'Breakfast', 'per_guest_night', 8, 'EUR', $2) RETURNING id::text`,
    [propertyId, status],
  );
  return result.rows[0]!.id;
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
    for (const table of [
      "platform.product_audit_events",
      "pms.checkin_settings",
      "booking.addon_definitions",
    ])
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
