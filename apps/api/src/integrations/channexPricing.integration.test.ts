import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgChannelDatePrices } from "../domains/pmsChannelDatePrices.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("saved Channex pricing", () => {
  const pool = new pg.Pool({ connectionString: url });
  const prices = createPgChannelDatePrices(url ?? "postgresql://disabled");
  const propertyId = randomUUID(),
    roomTypeId = randomUUID(),
    ratePlanId = randomUUID(),
    userId = randomUUID();
  const scope = { propertyId, roomTypeId, ratePlanId, stayDate: "2026-12-31" };
  const context = { actor: { internalUserId: userId } } as RequestContext;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.includes("test"))
      throw new Error("Isolated local test database required");
    await pool.query(`INSERT INTO identity.users(id,email) VALUES ($1,$2)`, [
      userId,
      `${userId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1,$2,'VAY-1527 Test')`,
      [propertyId, propertyId],
    );
    await pool.query(`INSERT INTO pms.room_types(id,property_id,name) VALUES ($1,$2,'Test room')`, [
      roomTypeId,
      propertyId,
    ]);
    await pool.query(
      `INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ($1,'EUR')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,
      pricing_contract_version,flexible_rate_plan_revision,source_room_facts_revision,source_pricing_currency_revision,cancellation_policy_snapshot)
      VALUES ($1,$2,$3,'flexible','Flexible','flexible',100,'EUR','pms-pricing.v1',1,1,1,
      '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":1,"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}')`,
      [ratePlanId, propertyId, roomTypeId],
    );
  });
  afterAll(async () => {
    await prices.close();
    await pool.end();
  });

  it("persists, replays, edits and removes date prices with tenant and revision checks", async () => {
    const command = {
      ...scope,
      commandId: randomUUID(),
      expectedRevision: 0,
      amountDecimal: "80.05",
      currency: "EUR",
    };
    expect(await prices.put(context, command)).toMatchObject({
      amountDecimal: "80.05",
      revision: 1,
    });
    expect(await prices.put(context, command)).toMatchObject({
      amountDecimal: "80.05",
      revision: 1,
    });
    expect(await prices.put(context, { ...command, amountDecimal: "90.00" })).toBeNull();
    expect(await prices.get({ ...scope, propertyId: randomUUID() })).toBeNull();
    expect(
      await prices.put(context, { ...command, propertyId: randomUUID(), commandId: randomUUID() }),
    ).toBeNull();
    expect(
      await prices.put(context, {
        ...command,
        currency: "USD",
        expectedRevision: 1,
        commandId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await prices.put(context, {
        ...command,
        amountDecimal: "70.00",
        expectedRevision: 1,
        commandId: randomUUID(),
      }),
    ).toMatchObject({ revision: 2 });
    expect(
      await prices.put(context, {
        ...command,
        amountDecimal: null,
        expectedRevision: 2,
        commandId: randomUUID(),
      }),
    ).toMatchObject({ revision: 3, amountDecimal: null });
    expect(await prices.put(context, command)).toBeNull();
    expect(await prices.get(scope)).toMatchObject({ revision: 3, amountDecimal: null });
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1`,
          [propertyId],
        )
      ).rows[0].count,
    ).toBe(3);
    const concurrent = { ...command, expectedRevision: 3, commandId: randomUUID().toUpperCase() };
    const writes = await Promise.all([
      prices.put(context, concurrent),
      prices.put(context, {
        ...concurrent,
        ratePlanId: ratePlanId.toUpperCase(),
        commandId: randomUUID(),
      }),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    if (writes[0]) expect(await prices.put(context, concurrent)).toEqual(writes[0]);
    expect(await prices.get(scope)).toEqual({
      amountDecimal: "80.05",
      currency: "EUR",
      revision: 4,
    });
  });
});
