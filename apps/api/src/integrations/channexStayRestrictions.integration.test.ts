import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPgChannexManagementPlanPort } from "./channexManagementPlans.js";
import { createChannexManagementProvider } from "./channexManagement.js";
import { pmsRoomStayRestrictionReason } from "../domains/pmsRoomSelectionConflicts.js";
import { replaceStayRestrictions } from "../domains/pmsStayRestrictions.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("canonical Channex stay restrictions", () => {
  let db: pg.Client;
  let property: string, room: string, rate: string, otherRate: string, connection: string;
  beforeEach(async () => {
    if (
      !url ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
      !new URL(url).pathname.includes("test")
    )
      throw new Error("Local test database required");
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    [property, room, rate, otherRate, connection] = Array.from({ length: 5 }, () => randomUUID());
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Restriction Test')",
      [property],
    );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Pacific/Kiritimati')",
      [property],
    );
    await db.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [
      room,
      property,
    ]);
    await db.query(
      `INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,base_rate_amount,currency)
      VALUES($1,$3,$4,'flex','Flexible',100,'EUR'),($2,$3,$4,'other','Other',100,'EUR')`,
      [rate, otherRate, property, room],
    );
    await db.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
      VALUES($1::uuid,'channex',$1::text,'active','repair')`,
      [property],
    );
    await db.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id)
      VALUES($1::uuid,$2::uuid,'channex','connected',$2::text)`,
      [connection, property],
    );
    await db.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,$3::text)`,
      [property, connection, room],
    );
    await db.query(
      `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
      SELECT $1::uuid,$2::uuid,$3::uuid,id,'direct',$3::text,id::text FROM pms.rate_plans WHERE property_id=$1`,
      [property, connection, room],
    );
    await db.query(
      `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count)
      SELECT $1,$2,day,2,2 FROM generate_series('2026-09-10'::date,'2026-09-15'::date,interval '1 day') day`,
      [property, room],
    );
  });
  afterEach(async () => {
    await db.query("ROLLBACK");
    await db.end();
  });
  const base = {
    startsOn: "2026-09-11",
    endsOn: "2026-09-14",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    minStayNights: null,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    stopSell: false,
    enabled: true,
  };
  const job = () => ({
    jobId: randomUUID(),
    propertyId: property,
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: {
      operationType: "sync_ari" as const,
      restrictionsOnly: true,
      commandId: "test",
      idempotencyKey: "test",
    },
  });
  function port() {
    return createPgChannexManagementPlanPort({
      connectionString: url!,
      now: () => new Date("2026-09-10T11:00:00Z"),
      pool: {
        query: db.query.bind(db),
        connect: async () => ({
          // Keep planner transactions inside the rollback-only fixture transaction.
          query: (sql: string, parameters?: unknown[]) =>
            db.query(
              sql.startsWith("BEGIN")
                ? "SAVEPOINT planner"
                : ({
                    COMMIT: "RELEASE SAVEPOINT planner",
                    ROLLBACK: "ROLLBACK TO SAVEPOINT planner",
                  }[sql] ?? sql),
              parameters,
            ),
          release() {},
        }),
        end: async () => {},
      },
      bookingRevisionHandoff: vi.fn(),
    });
  }
  async function values() {
    const plan = await port().plan(job());
    return (
      plan.requests.find((r) => r.path === "/api/v1/restrictions")!.body as {
        values: Record<string, unknown>[];
      }
    ).values;
  }
  async function allowed(checkIn: string, checkOut: string, ratePlanId = rate) {
    return (
      (await pmsRoomStayRestrictionReason(db, {
        propertyId: property,
        roomTypeId: room,
        ratePlanId,
        checkIn,
        checkOut,
      })) === null
    );
  }
  it("sends Friday arrival minimum, maximum, boundary closures and rate-scoped stop sell", async () => {
    await replaceStayRestrictions(db, property, {
      roomTypeId: room,
      ratePlanId: rate,
      rules: [
        { ...base, daysOfWeek: [5], minStayNights: 3, maxStayNights: 14 },
        { ...base, daysOfWeek: [0], closedToArrival: true, closedToDeparture: true },
        { ...base, startsOn: "2026-09-14", stopSell: true },
      ],
    });
    const rows = await values();
    expect(rows.every((row) => !("rate" in row))).toBe(true);
    expect(rows.find((r) => r.rate_plan_id === rate && r.date_from === "2026-09-11")).toMatchObject(
      {
        property_id: property,
        min_stay_arrival: 3,
        min_stay_through: 1,
        max_stay: 14,
        stop_sell: false,
      },
    );
    expect(rows.find((r) => r.rate_plan_id === rate && r.date_from === "2026-09-13")).toMatchObject(
      { closed_to_arrival: true, closed_to_departure: true },
    );
    expect(rows.find((r) => r.rate_plan_id === rate && r.date_from === "2026-09-14")).toMatchObject(
      { stop_sell: true },
    );
    expect(
      rows.filter((r) => r.rate_plan_id === otherRate).every((r) => r.stop_sell === false),
    ).toBe(true);
    expect(rows.every((r) => String(r.date_from) >= "2026-09-11")).toBe(true);
    expect(await allowed("2026-09-11", "2026-09-13")).toBe(false);
    expect(await allowed("2026-09-11", "2026-09-14")).toBe(true);
    expect(await allowed("2026-09-11", "2026-09-26")).toBe(false);
    expect(await allowed("2026-09-12", "2026-09-14")).toBe(true);
    expect(await allowed("2026-09-13", "2026-09-14")).toBe(false);
    expect(await allowed("2026-09-12", "2026-09-13")).toBe(false);
    expect(await allowed("2026-09-14", "2026-09-15")).toBe(false);
    expect(await allowed("2026-09-14", "2026-09-15", otherRate)).toBe(true);
  });
  it("recomputes fallback on shortening, disabling and deleting, including old retry jobs", async () => {
    await db.query(
      `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,min_stay_nights,max_stay_nights)
      VALUES($1,$2,'season','2026-09-11','2026-09-15',2,14)`,
      [property, room],
    );
    const replacement = {
      roomTypeId: room,
      ratePlanId: rate,
      rules: [{ ...base, minStayNights: 3, stopSell: true }],
    };
    await replaceStayRestrictions(db, property, replacement);
    const oldJob = job();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test",
      plans: port(),
      fetch: fetcher,
    });
    await provider.execute(oldJob);
    for (const rules of [
      [{ ...replacement.rules[0]!, endsOn: "2026-09-11" }],
      [{ ...replacement.rules[0]!, enabled: false }],
      [],
    ]) {
      await replaceStayRestrictions(db, property, { ...replacement, rules });
      expect(await provider.execute({ ...oldJob, attemptNumber: 2 })).toMatchObject({ ok: true });
      const body = JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string);
      expect(
        body.values.find(
          (r: Record<string, unknown>) => r.rate_plan_id === rate && r.date_from === "2026-09-14",
        ),
      ).toMatchObject({
        min_stay_arrival: 2,
        min_stay_through: 1,
        max_stay: 14,
        stop_sell: false,
        closed_to_arrival: false,
        closed_to_departure: false,
      });
    }
    await db.query("DELETE FROM pms.rate_rules WHERE property_id=$1", [property]);
    expect((await values())[0]).toMatchObject({
      min_stay_arrival: 1,
      max_stay: 0,
      min_stay_through: 1,
      stop_sell: false,
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE property_id=$1 AND job_type='channex.sync_ari'",
          [property],
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
    // Several full-horizon recomputations share the populated CI database.
  }, 15_000);
  it("scopes refresh and claims to one property and leaves other operations untouched", async () => {
    const otherProperty = randomUUID();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Other')",
      [otherProperty],
    );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [otherProperty],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1::uuid,'channex',$1::text,'active','repair')",
      [otherProperty],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES($1::uuid,'channex','connected',$1::text)",
      [otherProperty],
    );
    await db.query("SELECT pms.enqueue_restriction_ari($1,'outside')", [otherProperty]);
    await db.query("SELECT pms.enqueue_restriction_ari($1,'full-ari')", [property]);
    await db.query(
      "UPDATE platform.jobs SET payload=payload-'restrictionsOnly', priority=100 WHERE property_id=$1",
      [property],
    );
    const before = (
      await db.query("SELECT * FROM platform.jobs WHERE property_id=ANY($1::uuid[]) ORDER BY id", [
        [property, otherProperty],
      ])
    ).rows;
    const worker = createPgPmsChannexManagementWorkerStore({
      connectionString: url!,
      stagingRestrictionsPropertyId: property,
      targetState: { succeed: vi.fn(), fail: vi.fn() },
      pool: {
        end: async () => {},
        connect: async () => ({
          release() {},
          query: ((text: string, values?: unknown[]) =>
            db.query(
              (
                {
                  BEGIN: "SAVEPOINT scoped_worker",
                  COMMIT: "RELEASE SAVEPOINT scoped_worker",
                  ROLLBACK: "ROLLBACK TO SAVEPOINT scoped_worker",
                } as Record<string, string>
              )[text] ?? text,
              values,
            )) as pg.PoolClient["query"],
        }),
      },
    });
    const claimed = await worker.claim({ workerId: "scoped", now: new Date() });
    expect(claimed).toMatchObject({
      propertyId: property,
      input: { operationType: "sync_ari", restrictionsOnly: true },
    });
    expect(
      (
        await db.query("SELECT * FROM platform.jobs WHERE id=ANY($1::uuid[]) ORDER BY id", [
          before.map((row) => row.id),
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE property_id=$1 AND job_key LIKE '%full:%'",
          [otherProperty],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await worker.claim({ workerId: "scoped", now: new Date() })).toBeNull();
  });

  it("reconciles only established staging meal mappings without provisioning variants", async () => {
    await db.query("UPDATE pms.rate_plans SET meal_plan='breakfast' WHERE id=$1", [rate]);
    const planner = createPgChannexManagementPlanPort({
      connectionString: url!,
      stagingMealsPropertyId: property,
      bookingRevisionHandoff: async () => {},
      pool: { query: db.query.bind(db), end: async () => {} } as unknown as pg.Pool,
    });
    const input = {
      ...job(),
      input: {
        operationType: "provision" as const,
        mealRatePlanId: rate,
        commandId: randomUUID(),
        idempotencyKey: "staging-meal",
        actorUserId: randomUUID(),
      },
    };
    const plan = await planner.plan(input);
    expect(plan.requests).toEqual([]);
    expect(plan.meals).toEqual([
      expect.objectContaining({
        ratePlanId: rate,
        channel: "direct",
        externalRatePlanId: rate,
        mealType: "breakfast",
      }),
    ]);
    await db.query("DELETE FROM pms.channel_rate_plan_mappings WHERE rate_plan_id=$1", [rate]);
    await expect(planner.plan(input)).rejects.toThrow("requires an existing mapped rate");
  });

  it("claims only explicitly scoped meal jobs when opted in", async () => {
    const otherProperty = randomUUID();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Other')",
      [otherProperty],
    );
    const jobs = [
      [otherProperty, { operationType: "provision", mealRatePlanId: rate }],
      [property, { operationType: "provision" }],
      [property, { operationType: "provision", mealRatePlanId: "invalid" }],
      [property, { operationType: "sync_bookings", mealRatePlanId: rate }],
      [property, { operationType: "provision", mealRatePlanId: rate }],
    ] as const;
    const ids: string[] = [];
    for (const [owner, payload] of jobs) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,payload)
        VALUES($1::uuid,$1::text,'pms.channex.management','channex.provision','property',$2,$3::jsonb)`,
        [id, owner, JSON.stringify(payload)],
      );
    }
    const worker = (enabled: boolean) =>
      createPgPmsChannexManagementWorkerStore({
        connectionString: url!,
        ariSyncMutating: false,
        stagingRestrictionsPropertyId: property,
        stagingMealsEnabled: enabled,
        targetState: { succeed: vi.fn(), fail: vi.fn() },
        pool: {
          end: async () => {},
          connect: async () => ({
            release() {},
            query: ((text: string, values?: unknown[]) =>
              db.query(
                (
                  {
                    BEGIN: "SAVEPOINT meal_worker",
                    COMMIT: "RELEASE SAVEPOINT meal_worker",
                    ROLLBACK: "ROLLBACK TO SAVEPOINT meal_worker",
                  } as Record<string, string>
                )[text] ?? text,
                values,
              )) as pg.PoolClient["query"],
          }),
        },
      });
    expect(await worker(false).claim({ workerId: "meals", now: new Date() })).toBeNull();
    const claimed = await worker(true).claim({ workerId: "meals", now: new Date() });
    expect(claimed).toMatchObject({
      jobId: ids[4],
      propertyId: property,
      input: { operationType: "provision", mealRatePlanId: rate },
    });
    expect(
      (
        await db.query("SELECT status FROM platform.jobs WHERE id=ANY($1::uuid[])", [
          ids.slice(0, 4),
        ])
      ).rows,
    ).toEqual(Array.from({ length: 4 }, () => ({ status: "pending" })));
  });

  it("claims only opted-in inventory rules for the staging property", async () => {
    const otherProperty = randomUUID();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Other')",
      [otherProperty],
    );
    const jobs = [
      [otherProperty, { operationType: "update_inventory_rules" }],
      [property, { operationType: "provision" }],
      [property, { operationType: "provision", mealRatePlanId: "invalid" }],
      [property, { operationType: "sync_bookings", mealRatePlanId: rate }],
      [property, { operationType: "update_inventory_rules" }],
    ] as const;
    const ids: string[] = [];
    for (const [owner, payload] of jobs) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,payload)
        VALUES($1::uuid,$1::text,'pms.channex.management','channex.provision','property',$2,$3::jsonb)`,
        [id, owner, JSON.stringify(payload)],
      );
    }
    // Suppress the unrelated periodic restrictions enqueue for this claim-only test.
    await db.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [property]);
    const worker = (enabled: boolean, ari = true) =>
      createPgPmsChannexManagementWorkerStore({
        connectionString: url!,
        ariSyncMutating: ari,
        stagingRestrictionsPropertyId: property,
        stagingInventoryEnabled: enabled,
        targetState: { succeed: vi.fn(), fail: vi.fn() },
        pool: {
          end: async () => {},
          connect: async () => ({
            release() {},
            query: ((text: string, values?: unknown[]) =>
              db.query(
                (
                  {
                    BEGIN: "SAVEPOINT meal_worker",
                    COMMIT: "RELEASE SAVEPOINT meal_worker",
                    ROLLBACK: "ROLLBACK TO SAVEPOINT meal_worker",
                  } as Record<string, string>
                )[text] ?? text,
                values,
              )) as pg.PoolClient["query"],
          }),
        },
      });
    expect(await worker(false).claim({ workerId: "meals", now: new Date() })).toBeNull();
    expect(await worker(true, false).claim({ workerId: "inventory", now: new Date() })).toBeNull();
    const claimed = await worker(true).claim({ workerId: "meals", now: new Date() });
    expect(claimed).toMatchObject({
      jobId: ids[4],
      propertyId: property,
      input: { operationType: "update_inventory_rules" },
    });
    expect(
      (
        await db.query("SELECT status FROM platform.jobs WHERE id=ANY($1::uuid[])", [
          ids.slice(0, 4),
        ])
      ).rows,
    ).toEqual(Array.from({ length: 4 }, () => ({ status: "pending" })));
  });

  it("delivers automatic changes and daily full sync through guarded, serialized durable jobs", async () => {
    const pool = {
      end: async () => {},
      connect: async () => ({
        release() {},
        query: ((text: string, values?: unknown[]) =>
          db.query(
            (
              {
                BEGIN: "SAVEPOINT worker",
                COMMIT: "RELEASE SAVEPOINT worker",
                ROLLBACK: "ROLLBACK TO SAVEPOINT worker",
              } as Record<string, string>
            )[text] ?? text,
            values,
          )) as pg.PoolClient["query"],
      }),
    };
    await db.query(
      "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id<>$1",
      [property],
    );
    await db.query(
      "UPDATE platform.jobs SET run_after=now()+interval '1 day' WHERE property_id<>$1",
      [property],
    );
    const state = { succeed: vi.fn(), fail: vi.fn() };
    const store = (ariSyncMutating: boolean) =>
      createPgPmsChannexManagementWorkerStore({
        connectionString: url!,
        pool,
        targetState: state,
        ariSyncMutating,
      });
    await replaceStayRestrictions(db, property, {
      roomTypeId: room,
      ratePlanId: rate,
      rules: [{ ...base, stopSell: true }],
    });
    expect(await store(false).claim({ workerId: "guarded", now: new Date() })).toBeNull();
    const worker = store(true);
    const claimed = await worker.claim({ workerId: "worker", now: new Date() });
    expect(claimed).toMatchObject({ propertyId: property, input: { operationType: "sync_ari" } });
    expect(claimed!.input).not.toHaveProperty("restrictions");
    const automaticPlan = await port().plan(claimed!);
    expect(automaticPlan.requests).toHaveLength(2);
    expect(automaticPlan.requests[0]?.body).toEqual({
      property: { settings: { min_stay_type: "arrival" } },
    });
    expect(automaticPlan.requests[1]?.path).toBe("/api/v1/restrictions");
    expect(
      (automaticPlan.requests[1]?.body as { values: unknown[] }).values.every(
        (value) => !("rate" in (value as object)),
      ),
    ).toBe(true);
    expect(await worker.claim({ workerId: "other-worker", now: new Date() })).toBeNull();
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE property_id=$1 AND job_key LIKE '%full:%'",
          [property],
        )
      ).rows[0].n,
    ).toBe(1);
    const result = await worker.fail(
      claimed!,
      { ok: false, code: "timeout", message: "test timeout" },
      { workerId: "worker", now: new Date(), retryable: true, retryAt: new Date() },
    );
    expect(result).toBe("retry_scheduled");
  });

  it("rejects conflicting edits from other canonical writers at commit", async () => {
    await db.query(
      `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,max_stay_nights)
      VALUES($1,$2,'season','2026-09-11','2026-09-15',2)`,
      [property, room],
    );
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("SAVEPOINT writer");
    await db.query(
      `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,min_stay_nights)
      VALUES($1,$2,'daily_rate','2026-09-13','2026-09-13',3)`,
      [property, room],
    );
    await expect(db.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow("Conflicting");
    await db.query("ROLLBACK TO writer");
    await db.query("SET LOCAL session_replication_role=replica");
    await db.query(
      `INSERT INTO pms.operating_calendar_revisions
      (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,
       schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
       idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
      VALUES(gen_random_uuid(),$1,1,'pms-operating-calendar.v1',1,'Pacific/Kiritimati','year_round',0,1,1,
       gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
      [property],
    );
    await db.query("SET LOCAL session_replication_role=origin");
    await db.query("SAVEPOINT calendar");
    await db.query(
      `WITH idem AS (
      INSERT INTO platform.idempotency_keys(operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
      VALUES('pms','calendar-test','test','test','property',$1,now()+interval '1 day') RETURNING id
    ), event AS (
      INSERT INTO platform.domain_events(source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id)
      VALUES('pms','calendar-test:'||$1::text,'pms.inventory.changed',now(),'property',$1,'pms','property',$1::text) RETURNING id
    ), outbox AS (
      INSERT INTO platform.outbox_events(domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id)
      SELECT id,'calendar-test:'||$1::text,'test','pms.inventory.changed','property',$1 FROM event RETURNING id
    ) INSERT INTO pms.operating_calendar_revisions
      (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,
       schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
       idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
      SELECT gen_random_uuid(),$1,2,'pms-operating-calendar.v1',1,'Pacific/Kiritimati','year_round',0,1,3,
        idem.id,event.id,outbox.id,gen_random_uuid(),now(),now() FROM idem,event,outbox`,
      [property],
    );
    await expect(
      db.query("SET CONSTRAINTS pms.pms_validate_calendar_stay_restrictions IMMEDIATE"),
    ).rejects.toThrow("Conflicting");
    await db.query("ROLLBACK TO calendar");
    expect((await values()).find((row) => row.rate_plan_id === rate)).toMatchObject({
      min_stay_arrival: 1,
      max_stay: 2,
    });
  });

  it("rejects conflicting overlaps and tenant-crossing mappings before provider delivery", async () => {
    await db.query(
      `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,min_stay_nights)
      VALUES($1,$2,'season','2026-09-11','2026-09-15',5)`,
      [property, room],
    );
    await db.query("SAVEPOINT invalid_rule");
    await expect(
      replaceStayRestrictions(db, property, {
        roomTypeId: room,
        ratePlanId: rate,
        rules: [{ ...base, maxStayNights: 3 }],
      }),
    ).rejects.toThrow("Conflicting");
    await db.query("ROLLBACK TO invalid_rule");
    await expect(
      replaceStayRestrictions(db, randomUUID(), { roomTypeId: room, ratePlanId: rate, rules: [] }),
    ).rejects.toThrow("scope_not_found");
    await db.query("DELETE FROM pms.channel_rate_plan_mappings WHERE rate_plan_id=$1", [otherRate]);
    const fetcher = vi.fn<typeof fetch>();
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test",
      plans: port(),
      fetch: fetcher,
    });
    expect(await provider.execute(job())).toMatchObject({ ok: false, code: "mapping_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
