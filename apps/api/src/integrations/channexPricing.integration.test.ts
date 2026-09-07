import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgChannelDatePrices } from "../domains/pmsChannelDatePrices.js";

import { createPgChannexManagementPlanPort } from "./channexManagementPlans.js";
import { createChannexManagementProvider } from "./channexManagement.js";

import { createPgChannexAriSchedule } from "../jobs/pmsChannexAriSchedule.js";

import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { createPmsChannexManagementTargetState } from "../jobs/pmsChannexManagementTargetState.js";

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
  const dates = [
    "2026-12-27",
    "2026-12-28",
    "2026-12-29",
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
    "2027-01-09",
  ];
  const seasonId = randomUUID(),
    weekendId = randomUUID(),
    connectionId = randomUUID();
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES ($1,'Asia/Taipei')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES ($1,'channex',$2,'active','enable')`,
      [propertyId, propertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,external_property_id,connection_status) VALUES ($1::uuid,$2::uuid,'channex',$2::text,'connected')`,
      [connectionId, propertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$3::text)`,
      [propertyId, connectionId, roomTypeId],
    );
    await pool.query(
      `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id,markup_percent)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,channel,$3::text,$4::text||channel,markup FROM (VALUES ('direct',0),('booking_com',10)) channels(channel,markup)`,
      [propertyId, connectionId, roomTypeId, ratePlanId],
    );
    await pool.query(
      `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count) SELECT $1,$2,day,1,1 FROM unnest($3::date[]) day`,
      [propertyId, roomTypeId, dates],
    );
    await pool.query(
      `UPDATE pms.property_pricing_settings SET optional_pricing_aggregate_revision=2 WHERE property_id=$1`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.recurring_pricing_sources(id,property_id,source_kind,source_revision,configured_state,validation_state,validation_revision,validated_at,invalid_reasons,currency,source_pricing_currency_revision,season_name,season_start_month,season_start_day,season_end_month,season_end_day,weekend_days)
      VALUES ($1,$3,'season',1,'active','valid',1,now(),'[]','EUR',1,'Peak',12,30,1,2,NULL),
      ($2,$3,'weekend_surcharge',1,'active','valid',1,now(),'[]','EUR',1,NULL,NULL,NULL,NULL,NULL,ARRAY['saturday','sunday'])`,
      [seasonId, weekendId, propertyId],
    );
    await pool.query(
      `INSERT INTO pms.recurring_pricing_source_room_values(source_id,property_id,source_kind,room_type_id,source_room_facts_revision,flexible_rate_plan_id,flexible_pricing_contract_version,source_flexible_plan_revision,currency,source_pricing_currency_revision,seasonal_nightly_amount,weekend_surcharge_amount)
      VALUES ($1,$3,'season',$4,1,$5,'pms-pricing.v1',1,'EUR',1,180,NULL),($2,$3,'weekend_surcharge',$4,1,$5,'pms-pricing.v1',1,'EUR',1,NULL,40)`,
      [seasonId, weekendId, propertyId, roomTypeId, ratePlanId],
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
  it("sends saved canonical dates to the provider with one markup and decimal rounding", async () => {
    const plans = createPgChannexManagementPlanPort({
      connectionString: url!,
      now: () => new Date("2026-12-27T16:30:00Z"),
      bookingRevisionHandoff: async () => {},
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "local-test",
      plans,
      fetch: fetcher,
    });
    const job = {
      jobId: randomUUID(),
      propertyId,
      correlationId: null,
      attemptNumber: 1,
      maxAttempts: 5,
      input: {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        operationType: "sync_ari" as const,
      },
    };
    const sent = async () => {
      fetcher.mockClear();
      const result = await provider.execute(job);
      if (!result.ok) throw new Error(JSON.stringify(result));
      const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/restrictions"))!;
      return JSON.parse(call[1]!.body as string).values as {
        rate_plan_id: string;
        date_from: string;
        rate: string;
      }[];
    };
    try {
      const values = await sent();
      const rate = (day: string, channel = "booking_com") =>
        values.find((item) => item.date_from === day && item.rate_plan_id === ratePlanId + channel)
          ?.rate;
      expect(rate("2026-12-27")).toBeUndefined(); // UTC date is yesterday at the property.
      expect([rate("2026-12-28"), rate("2027-01-09"), rate("2026-12-30")]).toEqual([
        "110.00",
        "154.00",
        "198.00",
      ]);
      expect([
        rate("2026-12-28", "direct"),
        rate("2027-01-09", "direct"),
        rate("2026-12-30", "direct"),
      ]).toEqual(["100.00", "140.00", "180.00"]);
      expect(rate("2026-12-31")).toBe("88.06");
      expect(rate("2027-01-01")).toBe("198.00");
      expect(rate("2027-01-02")).toBe("242.00");
      const current = (await prices.get(scope))!;
      await prices.put(context, {
        ...scope,
        commandId: randomUUID(),
        expectedRevision: current.revision,
        currency: "EUR",
        amountDecimal: null,
      });
      await pool.query(
        `UPDATE pms.recurring_pricing_source_room_values SET seasonal_nightly_amount=190 WHERE source_id=$1`,
        [seasonId],
      );
      let updated = await sent();
      expect(
        updated.find(
          (item) => item.date_from === scope.stayDate && item.rate_plan_id.endsWith("booking_com"),
        )?.rate,
      ).toBe("209.00");
      await pool.query(
        `UPDATE pms.recurring_pricing_sources SET configured_state='disabled',source_revision=2 WHERE id=$1`,
        [seasonId],
      );
      updated = await sent();
      expect(
        updated.find(
          (item) => item.date_from === scope.stayDate && item.rate_plan_id.endsWith("booking_com"),
        )?.rate,
      ).toBe("110.00");
      expect(
        updated.find(
          (item) => item.date_from === "2027-01-09" && item.rate_plan_id.endsWith("booking_com"),
        )?.rate,
      ).toBe("154.00");
      await pool.query(`UPDATE pms.room_types SET room_facts_revision=2 WHERE id=$1`, [roomTypeId]);
      fetcher.mockClear();
      expect(await provider.execute(job)).toMatchObject({
        ok: false,
        code: "invalid_state",
        message: expect.stringMatching(/stale/),
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await plans.close();
    }
  });
  it("schedules each source transition once and shares manual pricing and cutover protection", async () => {
    const schedule = createPgChannexAriSchedule(url!);
    const otherSchedule = createPgChannexAriSchedule(url!);
    const now = new Date("2026-12-27T16:30:00Z");
    const plans = createPgChannexManagementPlanPort({
      connectionString: url!,
      now: () => now,
      bookingRevisionHandoff: async () => {},
    });
    const jobs = async () =>
      (
        await pool.query(
          `SELECT id AS "jobId",property_id AS "propertyId",payload AS input,
      correlation_id AS "correlationId",1 AS "attemptNumber",5 AS "maxAttempts" FROM platform.jobs
      WHERE property_id=$1 AND job_metadata->>'source'='channex-ari-schedule' ORDER BY created_at,id`,
          [propertyId],
        )
      ).rows;
    try {
      await pool.query(`UPDATE pms.room_types SET room_facts_revision=1 WHERE id=$1`, [roomTypeId]);
      await Promise.all([schedule.enqueue(now), otherSchedule.enqueue(now)]);
      let saved = await jobs();
      expect(saved).toHaveLength(1);
      const scheduled = await plans.plan(saved[0]);
      const manual = await plans.plan({
        ...saved[0],
        input: { ...saved[0].input, idempotencyKey: randomUUID(), commandId: randomUUID() },
      });
      expect(scheduled.requests).toEqual(manual.requests);
      await pool.query(
        `UPDATE pms.channel_connections SET last_ari_sync_at=now(),updated_at=now() WHERE id=$1`,
        [connectionId],
      );
      await schedule.enqueue(now);
      expect(await jobs()).toHaveLength(1);
      const previous = (await prices.get(scope))!;
      await prices.put(context, {
        ...scope,
        currency: "EUR",
        amountDecimal: "77.00",
        expectedRevision: previous.revision,
        commandId: randomUUID(),
      });
      await schedule.enqueue(now);
      expect(await jobs()).toHaveLength(2);
      await prices.put(context, {
        ...scope,
        currency: "EUR",
        amountDecimal: null,
        expectedRevision: previous.revision + 1,
        commandId: randomUUID(),
      });
      await schedule.enqueue(now);
      expect(await jobs()).toHaveLength(3);
      await schedule.enqueue(new Date("2026-12-28T16:30:00Z"));
      saved = await jobs();
      expect(saved).toHaveLength(4);
      const fetcher = vi.fn<typeof fetch>();
      const guarded = createChannexManagementProvider({
        apiBaseUrl: "https://staging.channex.io",
        apiKey: "local-test",
        plans,
        fetch: fetcher,
        canSyncAri: false,
      });
      expect(await guarded.execute(saved[0])).toMatchObject({ ok: false, code: "invalid_state" });
      expect(fetcher).not.toHaveBeenCalled();
      const store = createPgPmsChannexManagementWorkerStore({
        connectionString: url!,
        targetState: createPmsChannexManagementTargetState(),
      });
      try {
        await pool.query(
          `UPDATE platform.jobs SET priority=(SELECT COALESCE(MAX(priority),0)+1 FROM platform.jobs) WHERE property_id=$1`,
          [propertyId],
        );
        const claims = await Promise.all([
          store.claim({ workerId: "first", now }),
          store.claim({ workerId: "second", now }),
        ]);
        const owned = claims.filter((job) => job?.propertyId === propertyId);
        expect(owned).toHaveLength(1);
        const index = claims.indexOf(owned[0]!);
        await store.succeed(
          owned[0]!,
          { ok: true },
          { workerId: index === 0 ? "first" : "second", now },
        );
        await schedule.enqueue(new Date("2026-12-28T16:30:00Z"));
        expect(await jobs()).toHaveLength(4);
      } finally {
        await store.close?.();
      }
    } finally {
      await schedule.close();
      await otherSchedule.close();
      await plans.close();
    }
  });
});
