import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgBookingLocationMapRepository,
  readGuestLocation,
  readGuestLocationMap,
  type BookingLocationMapRepository,
} from "./domains/bookingLocationMap.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2126-";

// VAY-2126: next-api reads and switches the booking page's location map as `vayada_next_api_runtime`, so this
// suite runs the repository through the test login that mirrors that role's product-DML posture.
describe.skipIf(!TEST_DATABASE_URL)("Booking location map (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: BookingLocationMapRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-2126', 'active')`,
      [actorUserId, `vay-2126-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgBookingLocationMapRepository({
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

  it("can read the rooms and property and switch the map, and only inserts into the audit sink", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_column_privilege($1, 'booking.booking_settings', 'location_map_enabled', 'UPDATE')
           AS "switchUpdate",
         has_column_privilege($1, 'booking.booking_settings', 'nearby_places_enabled', 'UPDATE')
           AS "nearbySwitchUpdate",
         has_table_privilege($1, 'pms.room_types', 'SELECT') AS "roomsSelect",
         has_table_privilege($1, 'hotel_catalog.property_locations', 'SELECT') AS "locationSelect",
         has_table_privilege($1, 'platform.product_audit_events', 'INSERT') AS "auditInsert",
         has_table_privilege($1, 'platform.product_audit_events', 'UPDATE') AS "auditUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({
      switchUpdate: true,
      nearbySwitchUpdate: true,
      roomsSelect: true,
      locationSelect: true,
      auditInsert: true,
      auditUpdate: false,
    });
  });

  it("starts off, lists the operating rooms' pins and the property, and switches with an audit row", async () => {
    const propertyId = await seedProperty(admin, true);
    const before = await settingsRow(admin, propertyId);
    expect(before.enabled).toBe(false);

    expect(await repository.read(propertyId)).toEqual({
      enabled: false,
      nearbyEnabled: false,
      canSwitch: true,
      rooms: [
        {
          roomTypeId: expect.any(String),
          name: "Schwabing Loft",
          address: "Leopoldstraße 12, Munich",
          pin: { latitude: 48.15634, longitude: 11.58242 },
          atProperty: false,
          approximate: false,
        },
        // Half a pair or text is no pin: saved before VAY-2321 without one, the room is at the property.
        {
          roomTypeId: expect.any(String),
          name: "Family Apartment",
          address: null,
          pin: null,
          atProperty: true,
          approximate: false,
        },
        // VAY-2321, as guests see it: an area gets its pin rounded and its name instead of the street.
        {
          roomTypeId: expect.any(String),
          name: "Beach Villa",
          address: "Isarvorstadt",
          pin: { latitude: 48.13, longitude: 11.57 },
          atProperty: false,
          approximate: true,
        },
        // "Same as property" keeps the room's own place saved, unused.
        {
          roomTypeId: expect.any(String),
          name: "Garden Suite",
          address: null,
          pin: null,
          atProperty: true,
          approximate: false,
        },
        // A place of its own without a pin yet.
        {
          roomTypeId: expect.any(String),
          name: "Annex",
          address: null,
          pin: null,
          atProperty: false,
          approximate: false,
        },
        {
          roomTypeId: expect.any(String),
          name: "Lobby Room",
          address: null,
          pin: null,
          atProperty: true,
          approximate: false,
        },
      ],
      property: {
        name: "Alpenrose Apartments",
        address: "Maximilianstraße 3, 80539 Munich",
        pin: { latitude: 48.1394, longitude: 11.5835 },
        mapDisplayMode: "approximate",
      },
    });
    expect(await readGuestLocationMap(admin, propertyId)).toBeNull();
    // VAY-2445: the rooms' details maps still get the property's place while the switch is off.
    expect(await readGuestLocation(admin, propertyId)).toEqual({
      enabled: false,
      map: { property: { latitude: 48.14, longitude: 11.58, approximate: true } },
      propertyPin: { latitude: 48.1394, longitude: 11.5835 },
    });

    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };
    expect(await repository.setEnabled({ propertyId, enabled: true, audit })).toEqual({
      enabled: true,
    });
    // Guests get the property's pin as its visibility shows it: rounded to the area for Approximate.
    expect(await readGuestLocationMap(admin, propertyId)).toEqual({
      property: { latitude: 48.14, longitude: 11.58, approximate: true },
    });
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET map_display_mode='hidden' WHERE property_id=$1::uuid",
      [propertyId],
    );
    expect(await readGuestLocationMap(admin, propertyId)).toEqual({ property: null });
    await repository.setEnabled({ propertyId, enabled: false, audit });
    await repository.setEnabled({ propertyId, enabled: true, audit });
    expect(await repository.read(propertyId)).toMatchObject({ enabled: true });
    // The booking page publication hashes this row; a switch must not make a live page look edited.
    expect(await settingsRow(admin, propertyId)).toEqual({ ...before, enabled: true });

    const audits = await admin.query(
      `SELECT product, action, actor_user_id::text AS "actorUserId", redacted_payload AS payload,
              audit_metadata->>'organizationId' AS "organizationId"
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual(
      [
        ["booking.location_map.enabled", true],
        ["booking.location_map.disabled", false],
        ["booking.location_map.enabled", true],
      ].map(([action, enabled]) => ({
        product: "booking",
        action,
        actorUserId,
        payload: { enabled },
        organizationId,
      })),
    );
  });

  it("switches Show nearby places on its own, with an audit row and the row's updated_at kept (VAY-2326)", async () => {
    const propertyId = await seedProperty(admin, true);
    const before = await settingsRow(admin, propertyId);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };
    const nearby = (enabled: boolean) =>
      repository.setEnabled({ propertyId, enabled, setting: "nearbyPlaces", audit });

    expect(await nearby(true)).toEqual({ enabled: true });
    expect(await repository.read(propertyId)).toMatchObject({
      enabled: false,
      nearbyEnabled: true,
    });
    expect(await nearby(false)).toEqual({ enabled: false });
    expect(await repository.read(propertyId)).toMatchObject({
      enabled: false,
      nearbyEnabled: false,
    });
    expect(await settingsRow(admin, propertyId)).toEqual(before);

    const audits = await admin.query(
      `SELECT action, split_part(audit_key, ':', 1) AS "keyPrefix", redacted_payload AS payload
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual([
      {
        action: "booking.nearby_places.enabled",
        keyPrefix: "booking.nearby-places",
        payload: { enabled: true },
      },
      {
        action: "booking.nearby_places.disabled",
        keyPrefix: "booking.nearby-places",
        payload: { enabled: false },
      },
    ]);
  });

  it("switches nothing and audits nothing for a property without booking settings", async () => {
    const propertyId = await seedProperty(admin, false);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };

    expect(await repository.read(propertyId)).toMatchObject({ enabled: false, canSwitch: false });
    expect(await readGuestLocationMap(admin, propertyId)).toBeNull();
    expect(await repository.setEnabled({ propertyId, enabled: true, audit })).toBeNull();
    expect(
      await repository.setEnabled({ propertyId, enabled: true, setting: "nearbyPlaces", audit }),
    ).toBeNull();
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
  await admin.query(
    `INSERT INTO hotel_catalog.property_locations (
       property_id, country_code, city, street_address, postal_code, latitude, longitude,
       geo_public, map_display_mode
     ) VALUES ($1::uuid, 'DE', 'Munich', 'Maximilianstraße 3', '80539', 48.1394, 11.5835,
       TRUE, 'approximate')`,
    [propertyId],
  );
  const rooms: [string, boolean, number, Record<string, unknown>][] = [
    [
      "Schwabing Loft",
      true,
      1,
      { locationAddress: " Leopoldstraße 12, Munich ", latitude: 48.15634, longitude: 11.58242 },
    ],
    ["Family Apartment", true, 2, { latitude: 48.1, longitude: "11.5" }],
    ["Retired Studio", false, 0, { latitude: 48.2, longitude: 11.6 }],
    [
      "Beach Villa",
      true,
      3,
      {
        locationSource: "custom",
        locationPrecision: "approximate",
        locationArea: " Isarvorstadt ",
        locationAddress: "Fraunhoferstraße 9, Munich",
        latitude: 48.12961,
        longitude: 11.57443,
      },
    ],
    [
      "Garden Suite",
      true,
      4,
      {
        locationSource: "property",
        locationAddress: "Elsewhere 1",
        latitude: 48.2,
        longitude: 11.6,
      },
    ],
    ["Annex", true, 5, { locationSource: "custom", locationAddress: "Not placed yet" }],
    // Saved before VAY-2321 with the hotel's own pin: at the property, so its visibility still holds.
    ["Lobby Room", true, 6, { latitude: 48.13941, longitude: 11.5835 }],
  ];
  for (const [name, active, sortOrder, attributes] of rooms)
    await admin.query(
      `INSERT INTO pms.room_types (
         property_id, name, base_rate_amount, currency, occupancy_limits, room_attributes, active, sort_order
       ) VALUES ($1::uuid, $2, 100, 'EUR', '{"total":2}', $3::jsonb, $4, $5)`,
      [propertyId, name, JSON.stringify(attributes), active, sortOrder],
    );
  // Rows written before 0509 never name the new column; the default keeps the map off.
  if (withSettings)
    await admin.query(
      "INSERT INTO booking.booking_settings (property_id, updated_at) VALUES ($1::uuid, $2)",
      [propertyId, "2026-10-01T09:00:00.000Z"],
    );
  return propertyId;
}

async function settingsRow(admin: pg.Pool, propertyId: string) {
  const result = await admin.query<{ enabled: boolean; updatedAt: Date }>(
    `SELECT location_map_enabled AS enabled, updated_at AS "updatedAt"
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
    for (const table of [
      "platform.product_audit_events",
      "booking.booking_settings",
      "pms.room_types",
      "hotel_catalog.property_locations",
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
