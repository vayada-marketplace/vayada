import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import { lockPmsReplacementPricingRoomSource } from "./domains/pmsReplacementPricingRoomSource.js";
import type { PmsRoomTypeUpdateCommand } from "./routes/pmsOperations.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// VAY-2102: published pricing pins each room's exact room_attributes text, so a room
// location save that changes nothing must not write the row.
describe.skipIf(!TEST_DATABASE_URL)("PMS room-type location update", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const control = new pg.Client({ connectionString });
  const readRepository = createTargetPmsOperationsReadRepository({ connectionString });
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString,
    max: 2,
    readRepository,
    now: () => new Date("2026-10-10T09:00:00.000Z"),
  });
  const actorUserId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();

  beforeAll(async () => {
    assertSafeTestDatabase(connectionString);
    await control.connect();
    await control.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $1::text || '@example.test', 'PMS Room Location', 'active')`,
      [actorUserId],
    );
    await control.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $1::text, 'PMS Room Location')`,
      [propertyId],
    );
    await control.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, base_rate_amount, currency, occupancy_limits, room_attributes
       ) VALUES ($1::uuid, $2::uuid, 'Location Suite', 100, 'EUR', '{"total":2}', $3::jsonb)`,
      [
        roomTypeId,
        propertyId,
        JSON.stringify({
          beds: [{ type: "king", quantity: 1 }],
          bedrooms: 1,
          bathrooms: 1,
          bathroomType: "private",
          size: { value: 20, unit: "sqm" },
        }),
      ],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await readRepository.close?.();
    await control.end();
  });

  async function snapshot() {
    await control.query("BEGIN");
    try {
      const pin = await lockPmsReplacementPricingRoomSource(
        control as unknown as PoolClient,
        propertyId,
      );
      const row = await control.query<{ attributes: string; updatedAt: string }>(
        `SELECT room_attributes::text AS attributes, updated_at::text AS "updatedAt"
         FROM pms.room_types
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [propertyId, roomTypeId],
      );
      return { pin, ...row.rows[0]! };
    } finally {
      await control.query("ROLLBACK");
    }
  }

  function locationCommand(
    suffix: string,
    attributes: Record<string, string | number | null>,
  ): PmsRoomTypeUpdateCommand {
    const commandId = `pms-room-location-${suffix}-${roomTypeId}`;
    return {
      propertyId,
      roomTypeId,
      commandId,
      idempotencyKey: commandId,
      attributes,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId: randomUUID() },
        requestId: commandId,
        correlationId: commandId,
        reason: "Update room type location",
        requestedAt: "2026-10-10T09:00:00.000Z",
      },
    };
  }

  it("keeps the pricing room pin when nothing changed and writes only changed keys", async () => {
    const before = await snapshot();
    expect(before.pin).toMatch(/^pms\.pricing\.rooms\.v2:/);
    expect(JSON.parse(before.attributes)).not.toHaveProperty("locationAddress");

    const noop = locationCommand("noop", {
      locationAddress: null,
      latitude: null,
      longitude: null,
    });
    await expect(repository.updateRoomTypeLocation(noop)).resolves.toMatchObject({
      ok: true,
      roomType: { attributes: JSON.parse(before.attributes) },
    });
    await expect(repository.updateRoomTypeLocation(noop)).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(snapshot()).resolves.toEqual(before);

    await expect(
      repository.updateRoomTypeLocation(
        locationCommand("moved", {
          locationAddress: "Seestrasse 12, Innsbruck",
          latitude: null,
          longitude: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      roomType: { attributes: { locationAddress: "Seestrasse 12, Innsbruck" } },
    });
    const moved = await snapshot();
    expect(moved.pin).not.toBe(before.pin);
    expect(JSON.parse(moved.attributes)).toEqual({
      ...JSON.parse(before.attributes),
      locationAddress: "Seestrasse 12, Innsbruck",
    });
  });
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
