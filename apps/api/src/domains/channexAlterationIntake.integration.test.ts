import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  persistChannexAlteration,
  type ChannexAlterationScope,
} from "./channexAlterationIntake.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
describe.skipIf(!url)("Airbnb alteration intake (PostgreSQL)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const property = randomUUID(),
    connection = randomUUID(),
    generation = randomUUID();
  const externalProperty = randomUUID(),
    externalBooking = randomUUID(),
    booking = randomUUID();
  const room = randomUUID(),
    externalRoom = randomUUID();
  let scope: ChannexAlterationScope;
  const event = () => ({
    data: {
      id: scope.eventId,
      attributes: {
        property_id: externalProperty,
        event: "alteration_request",
        payload: {
          resolved: false,
          bms: {
            booking_id: externalBooking,
            property_id: externalProperty,
            arrival_date: "2026-10-01",
            departure_date: "2026-10-05",
            amount: "425.50" as string | null,
            currency: "EUR",
            rooms: [{ room_type_id: externalRoom, occupancy: { adults: 2, children: 1 } }],
          },
        },
      },
    },
  });
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES($1::uuid,$1::text,'Alteration test','active')`,
      [property],
    );
    await pool.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')`,
      [property, externalProperty],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id,binding_generation) VALUES($1,$2,'channex','connected',$3,$4)`,
      [connection, property, externalProperty, generation],
    );
    await pool.query(
      `INSERT INTO pms.room_types(id,property_id,name,currency,base_rate_amount) VALUES($1,$2,'Test','EUR',100)`,
      [room, property],
    );
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id) VALUES($1,$2,$3,$4)`,
      [property, connection, room, externalRoom],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,currency,total_amount,adults,children) VALUES($1::uuid,$2,$1::text,'airbnb','confirmed','2026-10-01','2026-10-03','EUR',300,2,0)`,
      [booking, property],
    );
    await pool.query(
      `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,channel,channel_room_index,sync_status) VALUES($1,$2,$3,$4,'channex',0,'active')`,
      [property, connection, booking, externalBooking],
    );
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM booking.booking_change_requests WHERE guest_booking_id=$1`, [
      booking,
    ]);
    scope = {
      propertyId: property,
      connectionId: connection,
      bindingGeneration: generation,
      providerPropertyId: externalProperty,
      eventId: randomUUID(),
    };
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM booking.booking_change_requests WHERE guest_booking_id=$1`, [
      booking,
    ]);
    await pool.query(`DELETE FROM pms.channel_booking_mappings WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM booking.guest_bookings WHERE id=$1`, [booking]);
    await pool.query(`DELETE FROM pms.channel_room_type_mappings WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM pms.room_types WHERE id=$1`, [room]);
    await pool.query(`DELETE FROM pms.channel_connections WHERE id=$1`, [connection]);
    await pool.query(`DELETE FROM pms.channel_binding_claims WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id=$1`, [property]);
    await pool.end();
  });
  it("stores a sanitized proposal without changing the booking and deduplicates concurrent delivery", async () => {
    const before = (
      await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
        booking,
      ])
    ).rows;
    const value = event();
    Object.assign(value.data.attributes.payload.bms, {
      raw_message: { credit_card: "must not persist" },
    });
    const results = await Promise.all([
      persistChannexAlteration(pool, scope, value),
      persistChannexAlteration(pool, scope, value),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.requestId).toBe(results[1]!.requestId);
    const rows = (
      await pool.query(
        `SELECT requested_changes FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
        [booking],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_changes).toMatchObject({
      oldTotal: "300.00",
      newTotal: "425.50",
      priceDifference: "125.50",
      requestedAdults: 2,
      requestedChildren: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("credit_card");
    expect(
      (
        await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
          booking,
        ])
      ).rows,
    ).toEqual(before);
  });
  it("keeps unknown price unknown", async () => {
    const value = event();
    value.data.attributes.payload.bms.amount = null;
    await persistChannexAlteration(pool, scope, value);
    expect(
      (
        await pool.query(
          `SELECT requested_changes FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows[0].requested_changes,
    ).toMatchObject({ newTotal: null, priceDifference: null });
  });
  it.each(["property", "generation", "booking", "room", "currency", "resolved", "dates"])(
    "rejects invalid %s without creating a request",
    async (kind) => {
      const value = event();
      if (kind === "property") value.data.attributes.property_id = randomUUID();
      if (kind === "generation") scope.bindingGeneration = randomUUID();
      if (kind === "booking") value.data.attributes.payload.bms.booking_id = randomUUID();
      if (kind === "room") value.data.attributes.payload.bms.rooms[0]!.room_type_id = randomUUID();
      if (kind === "currency") value.data.attributes.payload.bms.currency = "USD";
      if (kind === "resolved") value.data.attributes.payload.resolved = true;
      if (kind === "dates") value.data.attributes.payload.bms.departure_date = "2026-09-30";
      await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow();
      expect(
        (
          await pool.query(
            `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
            [booking],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it("rejects changed proposals and preserves terminal decisions on replay", async () => {
    const value = event();
    const result = await persistChannexAlteration(pool, scope, value);
    value.data.attributes.payload.bms.amount = "999.00";
    await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow(
      "alteration_identity_conflict",
    );
    await pool.query(
      `UPDATE booking.booking_change_requests SET status='declined',decided_at=now() WHERE id=$1`,
      [result.requestId],
    );
    expect(await persistChannexAlteration(pool, scope, event())).toEqual({
      ...result,
      replayed: true,
    });
    expect(
      (
        await pool.query(`SELECT status FROM booking.booking_change_requests WHERE id=$1`, [
          result.requestId,
        ])
      ).rows[0].status,
    ).toBe("declined");
  });
  it("serializes different concurrent events for the same booking", async () => {
    const first = event();
    const second = structuredClone(first);
    second.data.id = randomUUID();
    const results = await Promise.allSettled([
      persistChannexAlteration(pool, scope, first),
      persistChannexAlteration(pool, { ...scope, eventId: second.data.id }, second),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query(
          `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rejects a disconnected binding", async () => {
    await pool.query(
      `UPDATE pms.channel_connections SET connection_status='disconnected' WHERE id=$1`,
      [connection],
    );
    try {
      await expect(persistChannexAlteration(pool, scope, event())).rejects.toThrow(
        "alteration_connection_not_owned",
      );
    } finally {
      await pool.query(
        `UPDATE pms.channel_connections SET connection_status='connected' WHERE id=$1`,
        [connection],
      );
    }
  });
  it.each(["money", "occupancy"])("rejects malformed %s", async (kind) => {
    const value = event();
    if (kind === "money") value.data.attributes.payload.bms.amount = "NaN";
    else value.data.attributes.payload.bms.rooms[0]!.occupancy.adults = -1;
    await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow(
      "invalid_alteration_payload",
    );
  });
  it("rejects a second active request", async () => {
    await persistChannexAlteration(pool, scope, event());
    scope.eventId = randomUUID();
    await expect(persistChannexAlteration(pool, scope, event())).rejects.toThrow(
      "alteration_request_conflict",
    );
  });
});
