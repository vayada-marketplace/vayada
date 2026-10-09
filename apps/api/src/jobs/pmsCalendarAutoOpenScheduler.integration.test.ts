import { randomUUID } from "node:crypto";

import {
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "../domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgPmsCalendarAutoOpenWorkerStore,
  runPmsCalendarAutoOpenWorkerOnce,
} from "./pmsCalendarAutoOpenWorker.js";
import {
  PMS_CALENDAR_AUTO_OPEN_QUEUE,
  PMS_CALENDAR_AUTO_OPEN_SCHEDULER_LOCK,
  createPgPmsCalendarAutoOpenSchedulerStore,
  runPmsCalendarAutoOpenScheduler,
  type PgPmsCalendarAutoOpenSchedulerStore,
  type PmsCalendarAutoOpenCandidate,
} from "./pmsChannexScheduler.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const now = new Date("2026-09-03T10:00:00.000Z");

// VAY-2066: the producer and the consumer run in next-api as `vayada_next_api_runtime`, so this
// suite runs them through the test login that mirrors that role's product-DML posture.
describe.skipIf(!TEST_DATABASE_URL)("PMS calendar auto-open scheduler (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  let fixture: HotelSetupOrdinaryLoginFixture;
  const closers: Array<() => Promise<void>> = [];
  const schedulerStore = (): PgPmsCalendarAutoOpenSchedulerStore => {
    const store = createPgPmsCalendarAutoOpenSchedulerStore({
      connectionString: fixture.connectionString,
    });
    closers.push(() => store.close());
    return store;
  };

  const workerStore = () => {
    const propertyProfileEvidence =
      createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
        connectionString: fixture.connectionString,
      });
    const worker = createPgPmsCalendarAutoOpenWorkerStore({
      connectionString: fixture.connectionString,
      propertyProfileEvidence,
    });
    closers.push(async () => {
      await worker.close?.();
      await propertyProfileEvidence.close();
    });
    return worker;
  };

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
  });
  afterAll(async () => {
    try {
      for (const close of closers) await close();
      await fixture?.drop();
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanupFixtures(admin);
      }
    } finally {
      await admin.end();
    }
  });

  it("enqueues and applies one rolling window without permission or RLS failures", async () => {
    const property = await seedProperty(admin, 1);
    const store = schedulerStore();
    const worker = workerStore();

    const scheduled = await store.withRunLock((session) =>
      runPmsCalendarAutoOpenScheduler(session, { now, limit: 1, workerId: "vay-2066-test" }),
    );
    expect(scheduled.ran).toBe(true);
    // Other suites share this database, so only this property's outcome is asserted.
    expect(
      scheduled.ran &&
        scheduled.value.autoOpenFailures.filter(
          ({ propertyId }) => propertyId === property.propertyId,
        ),
    ).toEqual([]);
    expect(await propertyJobs(admin, property.propertyId)).toEqual([
      {
        status: "pending",
        jobKey: expect.stringMatching(
          new RegExp(
            `^pms\\.calendar-auto-open:property:${property.propertyId}:open-through-2027-09-30:`,
          ),
        ),
      },
    ]);

    await drainUntilDone(worker, property.propertyId);

    expect(await propertyJobs(admin, property.propertyId)).toEqual([
      { status: "succeeded", jobKey: expect.any(String) },
    ]);
    const applied = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM pms.inventory_days
          WHERE property_id=$1::uuid AND rate_gate_open IS TRUE) AS "openDays",
         (SELECT to_char(coverage_through, 'YYYY-MM-DD') FROM pms.inventory_materialization_coverage
          WHERE property_id=$1::uuid) AS "coverageThrough",
         (SELECT count(*)::int FROM platform.product_audit_events
          WHERE property_id=$1::uuid AND action='pms.calendar_auto_open.applied') AS audits,
         (SELECT count(*)::int FROM platform.jobs
          WHERE property_id=$1::uuid AND queue_name='pms.channex.management'
            AND job_type='channex.sync_ari') AS "ariJobs"`,
      [property.propertyId],
    );
    // 2026-09-03 through 2027-09-30 is 393 days; the outbox trigger queues one Channex ARI job.
    expect(applied.rows[0]).toEqual({
      openDays: 393,
      coverageThrough: "2027-09-30",
      audits: 1,
      ariJobs: 1,
    });

    // Once applied, the same source and horizon are reflected and the property is not reselected.
    const rerun = await store.withRunLock((session) =>
      session.findCalendarAutoOpenCandidates(now, 100),
    );
    expect(
      rerun.ran &&
        rerun.value.candidates.some(({ propertyId }) => propertyId === property.propertyId),
    ).toBe(false);
    expect(await propertyJobs(admin, property.propertyId)).toHaveLength(1);
  });

  it("applies a default job from the next release's producer (setting revision 0)", async () => {
    // A rolling deploy can hand jobs from the next release's producer to this consumer.
    const property = await seedProperty(admin, 3, { setting: "none" });
    const store = schedulerStore();
    const worker = workerStore();
    const source = createPmsCalendarAutoOpenSource({
      settingRevision: 0,
      propertyProfileRevision: 1,
      propertyTimeZone: "Europe/Berlin",
      operatingCalendarRevision: 1,
      rooms: [{ roomTypeId: property.roomTypeId, roomFactsRevision: 1, roomUnitsRevision: 1 }],
      pricing: {
        pricingCurrencyRevision: 1,
        flexibleRatePlans: [{ roomTypeId: property.roomTypeId, flexibleRatePlanRevision: 1 }],
        optionalPricingAggregateRevision: 0,
      },
    });

    await store.withRunLock((session) =>
      session.enqueueCalendarAutoOpenJob(
        {
          propertyId: property.propertyId,
          organizationId: property.organizationId,
          openFrom: "2026-09-03",
          openThrough: "2027-09-30",
          roomTypeIds: [property.roomTypeId],
          generatedCoverageThrough: null,
          source,
          sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(source),
        },
        { now, workerId: "vay-2066-test", correlationId: "vay-2066-test" },
      ),
    );
    await drainUntilDone(worker, property.propertyId);

    const applied = await admin.query(
      `SELECT job.job_metadata #>> '{calendarAutoOpenResult,outcome}' AS outcome,
              (SELECT to_char(coverage_through, 'YYYY-MM-DD')
               FROM pms.inventory_materialization_coverage coverage
               WHERE coverage.property_id=job.property_id) AS through,
              (SELECT count(*)::int FROM pms.calendar_auto_open_settings settings
               WHERE settings.property_id=job.property_id) AS settings
       FROM platform.jobs job WHERE job.property_id=$1::uuid AND job.queue_name=$2`,
      [property.propertyId, PMS_CALENDAR_AUTO_OPEN_QUEUE],
    );
    expect(applied.rows).toEqual([{ outcome: "applied", through: "2027-09-30", settings: 0 }]);
  });

  it("never opens dates for a suspended hotel", async () => {
    const property = await seedProperty(admin, 4);
    const store = schedulerStore();
    const worker = workerStore();
    const before = await store.withRunLock((session) =>
      session.findCalendarAutoOpenCandidates(now, 100),
    );
    const candidate =
      before.ran &&
      before.value.candidates.find(({ propertyId }) => propertyId === property.propertyId);
    expect(candidate).toBeTruthy();
    await store.withRunLock((session) =>
      session.enqueueCalendarAutoOpenJob(candidate as PmsCalendarAutoOpenCandidate, {
        now,
        workerId: "vay-2066-test",
        correlationId: "vay-2066-test",
      }),
    );

    await admin.query(
      `UPDATE hotel_catalog.properties SET lifecycle_status='suspended' WHERE id=$1::uuid`,
      [property.propertyId],
    );
    const after = await store.withRunLock((session) =>
      session.findCalendarAutoOpenCandidates(now, 100),
    );
    expect(
      after.ran &&
        after.value.candidates.some(({ propertyId }) => propertyId === property.propertyId),
    ).toBe(false);
    await drainUntilDone(worker, property.propertyId);

    const result = await admin.query(
      `SELECT job.job_metadata #>> '{calendarAutoOpenResult,outcome}' AS outcome,
              (SELECT count(*)::int FROM pms.inventory_days day
               WHERE day.property_id=job.property_id) AS days
       FROM platform.jobs job WHERE job.property_id=$1::uuid AND job.queue_name=$2`,
      [property.propertyId, PMS_CALENDAR_AUTO_OPEN_QUEUE],
    );
    expect(result.rows).toEqual([{ outcome: "unchanged", days: 0 }]);
  });

  it("lets one session scan at a time and frees the lock after a failed run", async () => {
    const first = schedulerStore();
    const second = schedulerStore();
    let entered!: () => void;
    let release!: () => void;
    const isEntered = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));

    const holding = first.withRunLock(async () => {
      entered();
      await held;
      return "first";
    });
    await isEntered;
    await expect(second.withRunLock(async () => "second")).resolves.toEqual({ ran: false });
    release();
    await expect(holding).resolves.toEqual({ ran: true, value: "first" });

    await expect(
      second.withRunLock(async () => {
        throw new Error("scheduler run failed");
      }),
    ).rejects.toThrow("scheduler run failed");
    await expect(first.withRunLock(async () => "again")).resolves.toEqual({
      ran: true,
      value: "again",
    });
  });

  it("survives losing the lock connection mid-run and frees the lock", async () => {
    const dropped = schedulerStore();
    const next = schedulerStore();
    const run = dropped.withRunLock(async (session) => {
      // The session is idle here; ending its backend makes pg emit "error" on the client.
      await admin.query(
        `WITH lock_key AS (SELECT hashtextextended($1, 0) AS value)
         SELECT pg_terminate_backend(lock.pid)
         FROM pg_locks lock, lock_key
         WHERE lock.locktype='advisory' AND lock.granted AND lock.objsubid=1
           AND lock.classid::bigint=((lock_key.value >> 32) & 4294967295)
           AND lock.objid::bigint=(lock_key.value & 4294967295)`,
        [PMS_CALENDAR_AUTO_OPEN_SCHEDULER_LOCK],
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      return session.findCalendarAutoOpenCandidates(now, 1);
    });

    await expect(run).rejects.toThrow();
    await expect(next.withRunLock(async () => "after")).resolves.toEqual({
      ran: true,
      value: "after",
    });
  });

  it("counts enabled settings skipped for unverified room labels", async () => {
    const store = schedulerStore();
    const stats = () => store.withRunLock((session) => session.readSelectionStats());
    const before = await stats();
    const property = await seedProperty(admin, 2);
    await admin.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, room_number, operational_label_status, status, sort_order
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'unverified', 'available', 1)`,
      [randomUUID(), property.propertyId, property.roomTypeId],
    );

    expect(before.ran).toBe(true);
    const after = await stats();
    expect(after).toEqual({
      ran: true,
      value: {
        enabledSettings: before.ran ? before.value.enabledSettings + 1 : NaN,
        skippedUnverifiedLabels: before.ran ? before.value.skippedUnverifiedLabels + 1 : NaN,
      },
    });
  });
});

type SeededProperty = { propertyId: string; roomTypeId: string; organizationId: string };

async function seedProperty(
  admin: pg.Pool,
  order: number,
  options: { setting?: "enabled" | "disabled" | "none"; calendar?: boolean } = {},
): Promise<SeededProperty> {
  const propertyId = `${order.toString(16).padStart(8, "0")}-0000-4000-8000-${randomUUID().replaceAll("-", "").slice(-12)}`;
  const roomTypeId = randomUUID();
  const organizationId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-2066 Candidate')`,
    [propertyId, `vay-2066-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
     VALUES ($1::uuid, 'Europe/Berlin')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name) VALUES ($1::uuid, $2::uuid, 'Candidate Room')`,
    [roomTypeId, propertyId],
  );
  await admin.query(
    `INSERT INTO pms.property_pricing_settings (property_id, currency) VALUES ($1::uuid, 'EUR')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO pms.rate_plans(
       id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,active,
       cancellation_policy_snapshot,pricing_contract_version,flexible_rate_plan_revision,
       source_room_facts_revision,source_pricing_currency_revision)
     VALUES($1::uuid,$2::uuid,$3::uuid,'flexible','Flexible','flexible',100,'EUR',TRUE,
       '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":1,
         "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
       'pms-pricing.v1',1,1,1)`,
    [randomUUID(), propertyId, roomTypeId],
  );
  if (options.setting !== "none") {
    await admin.query(
      `INSERT INTO pms.calendar_auto_open_settings
         (property_id, revision, enabled, mode, rolling_months, fixed_end_month)
       VALUES ($1::uuid, 1, $2, 'rolling', 12, NULL)`,
      [propertyId, options.setting !== "disabled"],
    );
  }
  await admin.query(
    `INSERT INTO pms.channel_binding_claims
       (property_id, provider, external_property_id, claim_state, claim_source)
     VALUES ($1::uuid, 'channex', $2, 'active', 'repair')`,
    [propertyId, `vay-2066-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.channel_connections
       (id, property_id, provider, connection_status, external_property_id, connection_metadata)
     VALUES ($1::uuid, $2::uuid, 'channex', 'connected', $3,
       jsonb_build_object('organizationId', $4::text))`,
    [randomUUID(), propertyId, `vay-2066-${propertyId}`, organizationId],
  );
  if (options.calendar === false) return { propertyId, roomTypeId, organizationId };

  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO pms.operating_calendar_revisions
         (organization_id, property_id, calendar_revision, contract_version,
          property_profile_revision, property_time_zone, schedule_mode,
          recurring_period_count, room_binding_count, default_minimum_stay_nights,
          idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 1, 'pms-operating-calendar.v1', 1, 'Europe/Berlin',
          'year_round', 0, 1, 1, $3::uuid, $4::uuid, $5::uuid, $6::uuid, now(), now())`,
      [organizationId, propertyId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings
         (property_id, calendar_revision, room_type_id, source_room_facts_revision,
          source_room_units_revision, physical_capacity_count, starting_sellable_limit_count)
       VALUES ($1::uuid, 1, $2::uuid, 1, 1, 2, 2)`,
      [propertyId, roomTypeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { propertyId, roomTypeId, organizationId };
}

// Other suites may leave jobs behind; drain the queue until this property's job is done.
async function drainUntilDone(
  worker: ReturnType<typeof createPgPmsCalendarAutoOpenWorkerStore>,
  propertyId: string,
): Promise<void> {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [job] = await propertyJobs(admin, propertyId);
      if (job?.status !== "pending" && job?.status !== "running") return;
      const result = await runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-2066-test",
        now: () => now,
      });
      if (result.outcome === "idle") return;
    }
  } finally {
    await admin.end();
  }
}

async function propertyJobs(admin: pg.Pool, propertyId: string) {
  const result = await admin.query<{ status: string; jobKey: string }>(
    `SELECT status, job_key AS "jobKey" FROM platform.jobs
     WHERE property_id=$1::uuid AND queue_name=$2 ORDER BY created_at`,
    [propertyId, PMS_CALENDAR_AUTO_OPEN_QUEUE],
  );
  return result.rows;
}

async function cleanupFixtures(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = await client.query<{ id: string }>(
      "SELECT id FROM hotel_catalog.properties WHERE public_id LIKE 'vay-2066-%'",
    );
    const ids = fixtures.rows.map(({ id }) => id);
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=ANY($1::uuid[]))",
      [ids],
    );
    for (const table of [
      "platform.dead_letter_events",
      "platform.product_audit_events",
      "platform.outbox_events",
      "platform.domain_events",
      "platform.idempotency_keys",
      "platform.jobs",
      "distribution.public_room_offer_snapshots",
      "distribution.public_hotel_bookability_profiles",
      "pms.inventory_days",
      "pms.inventory_materialization_coverage",
      "pms.channel_sync_status",
      "pms.channel_connections",
      "pms.channel_binding_claims",
      "pms.rate_plans",
      "pms.rooms",
      "pms.room_types",
      "pms.operating_calendar_room_bindings",
      "pms.operating_calendar_revisions",
      "pms.calendar_auto_open_settings",
      "pms.property_pricing_settings",
      "hotel_catalog.property_public_profile_read_model",
      "hotel_catalog.property_locations",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [ids]);
    }
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
