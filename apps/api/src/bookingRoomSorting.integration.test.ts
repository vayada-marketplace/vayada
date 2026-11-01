import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  DEFAULT_ROOM_SORTING,
  createPgBookingRoomSortingRepository,
  readGuestRoomSorting,
  type BookingRoomSortingRepository,
  type RoomSorting,
} from "./domains/bookingRoomSorting.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2449-";

const custom: RoomSorting = {
  enabled: true,
  hideWithOneRoom: false,
  options: [
    { key: "priceLow", enabled: true },
    { key: "recommended", enabled: true },
    { key: "bestDeal", enabled: true },
    { key: "priceHigh", enabled: false },
    { key: "roomSize", enabled: false },
    { key: "capacity", enabled: false },
  ],
  defaultOption: "bestDeal",
};

// VAY-2449: next-api reads and saves Room Sorting as `vayada_next_api_runtime`, so this suite runs the
// repository through the test login that mirrors that role's product-DML posture.
describe.skipIf(!TEST_DATABASE_URL)("Booking room sorting (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: BookingRoomSortingRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-2449', 'active')`,
      [actorUserId, `vay-2449-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgBookingRoomSortingRepository({
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

  it("can save the column and only inserts into the audit sink", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_column_privilege($1, 'booking.booking_settings', 'room_sorting', 'UPDATE') AS "update",
         has_table_privilege($1, 'platform.product_audit_events', 'INSERT') AS "auditInsert",
         has_table_privilege($1, 'platform.product_audit_events', 'UPDATE') AS "auditUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({ update: true, auditInsert: true, auditUpdate: false });
  });

  it("starts with the defaults, saves the hotel's own with an audit row, and keeps updated_at", async () => {
    const propertyId = await seedProperty(admin, true);
    const before = await settingsRow(admin, propertyId);
    expect(before.sorting).toBeNull();
    expect(await repository.read(propertyId)).toEqual({
      sorting: DEFAULT_ROOM_SORTING,
      defaults: DEFAULT_ROOM_SORTING,
      canSave: true,
    });
    // Guests get nothing until the hotel saves its own: the booking page uses the defaults.
    expect(await readGuestRoomSorting(admin, propertyId)).toBeNull();

    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };
    expect(await repository.save({ propertyId, sorting: custom, audit })).toEqual(custom);
    expect(await repository.read(propertyId)).toMatchObject({ sorting: custom, canSave: true });
    expect(await readGuestRoomSorting(admin, propertyId)).toEqual({
      enabled: true,
      hideWithOneRoom: false,
      options: ["priceLow", "recommended", "bestDeal"],
      defaultOption: "bestDeal",
    });
    const off = { ...custom, enabled: false };
    expect(await repository.save({ propertyId, sorting: off, audit })).toEqual(off);
    expect(await readGuestRoomSorting(admin, propertyId)).toMatchObject({ enabled: false });
    // The booking page publication hashes this row; a guest setting read live must not make a live page
    // look edited.
    expect((await settingsRow(admin, propertyId)).updatedAt).toEqual(before.updatedAt);

    const audits = await admin.query(
      `SELECT product, action, actor_user_id::text AS "actorUserId", redacted_payload AS payload,
              split_part(audit_key, ':', 1) AS "keyPrefix",
              audit_metadata->>'organizationId' AS "organizationId"
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual(
      [custom, off].map((payload) => ({
        product: "booking",
        action: "booking.room_sorting.updated",
        actorUserId,
        payload,
        keyPrefix: "booking.room-sorting",
        organizationId,
      })),
    );
  });

  it("reads a saved value that no longer reads as the defaults", async () => {
    const propertyId = await seedProperty(admin, true);
    await admin.query(
      `UPDATE booking.booking_settings SET room_sorting = '{"enabled": true}'::jsonb
       WHERE property_id=$1::uuid`,
      [propertyId],
    );
    expect(await repository.read(propertyId)).toMatchObject({ sorting: DEFAULT_ROOM_SORTING });
    expect(await readGuestRoomSorting(admin, propertyId)).toBeNull();
    await expect(
      admin.query(
        "UPDATE booking.booking_settings SET room_sorting = '[]'::jsonb WHERE property_id=$1::uuid",
        [propertyId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("saves nothing and audits nothing for a property without booking settings", async () => {
    const propertyId = await seedProperty(admin, false);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };

    expect(await repository.read(propertyId)).toEqual({
      sorting: DEFAULT_ROOM_SORTING,
      defaults: DEFAULT_ROOM_SORTING,
      canSave: false,
    });
    expect(await readGuestRoomSorting(admin, propertyId)).toBeNull();
    expect(await repository.save({ propertyId, sorting: custom, audit })).toBeNull();
    const audits = await admin.query(
      "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1::uuid",
      [propertyId],
    );
    expect(audits.rows[0]?.count).toBe(0);
    expect(await repository.read(randomUUID())).toBeNull();
  });
});

async function seedProperty(admin: pg.Pool, withSettings: boolean): Promise<string> {
  const propertyId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'Alpenrose Apartments')`,
    [propertyId, `${PUBLIC_ID_PREFIX}${propertyId}`],
  );
  // Rows written before 0534 never name the new column: NULL, the defaults.
  if (withSettings)
    await admin.query(
      "INSERT INTO booking.booking_settings (property_id, updated_at) VALUES ($1::uuid, $2)",
      [propertyId, "2026-10-01T09:00:00.000Z"],
    );
  return propertyId;
}

async function settingsRow(admin: pg.Pool, propertyId: string) {
  const result = await admin.query<{ sorting: unknown; updatedAt: Date }>(
    `SELECT room_sorting AS sorting, updated_at AS "updatedAt"
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
