import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTargetBookingSettingsRepository } from "./routes/bookingSettings.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// VAY-2101: Settings > Property showed the imported marketplace address even after the
// host saved a new location through the shared property profile.
describe.skipIf(!TEST_DATABASE_URL)("booking settings property address", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const control = new pg.Client({ connectionString });
  const repository = createPgTargetBookingSettingsRepository({ connectionString });
  const propertyId = randomUUID();

  beforeAll(async () => {
    assertSafeTestDatabase(connectionString);
    await control.connect();
    await control.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $1::text, 'Address Test Hotel')`,
      [propertyId],
    );
    await control.query(
      `INSERT INTO hotel_catalog.property_locations (
         property_id, country_code, city, raw_marketplace_location
       ) VALUES ($1::uuid, 'LK', 'Ahangama', 'X9H3+GPG, Welhengoda Road, Ahangama, Sri Lanka')`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await control.end();
  });

  it("shows the imported address until the location is saved natively", async () => {
    await expect(repository.findPropertySettingsByHotelId!(propertyId)).resolves.toMatchObject({
      address: "X9H3+GPG, Welhengoda Road, Ahangama, Sri Lanka",
    });

    await control.query(
      `UPDATE hotel_catalog.property_locations
       SET street_address = '1 Beach Road', postal_code = '80650', source_confidence = 'verified'
       WHERE property_id = $1::uuid`,
      [propertyId],
    );

    await expect(
      control.query(
        `SELECT revision::int AS revision FROM hotel_catalog.property_owner_revisions
         WHERE property_id = $1::uuid AND owner_key = 'hotel_catalog.location'`,
        [propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ revision: 2 }] });
    await expect(repository.findPropertySettingsByHotelId!(propertyId)).resolves.toMatchObject({
      address: "1 Beach Road, Ahangama, 80650, LK",
    });
  });
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
