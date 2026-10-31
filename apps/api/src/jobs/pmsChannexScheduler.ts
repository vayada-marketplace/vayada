import { createHash } from "node:crypto";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  PMS_CALENDAR_AUTO_OPEN_DEFAULT_CONFIGURATION,
  calculatePmsCalendarAutoOpenHorizon,
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
  isPmsCalendarAutoOpenFixedTargetWithinLimit,
  type PmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";
import pg from "pg";

export const PMS_CALENDAR_AUTO_OPEN_QUEUE = "pms.inventory.scheduler";
export const DEFAULT_PMS_CHANNEX_LIMIT = 100;
const CALENDAR_AUTO_OPEN_MAX_ATTEMPTS = 5;

// VAY-2352: this module once also pushed ARI from the outbox (`channex.push-ari`). Nothing ran it
// and it had no Channex sender. Availability reaches Channex through `channex.sync_ari` jobs
// (pmsChannexAriSchedule.ts and the 0323 inventory trigger) run by the management worker.
export type PmsChannexSchedulerRunName = "calendarAutoOpen";

export type PmsCalendarAutoOpenCandidate = {
  propertyId: string;
  organizationId: string;
  openFrom: string;
  openThrough: string;
  roomTypeIds: string[];
  generatedCoverageThrough: string | null;
  source: PmsCalendarAutoOpenSource;
  sourceFingerprint: string;
  correlationId?: string;
};

export type PmsChannexSchedulerContext = {
  now: Date;
  workerId: string;
  correlationId: string;
};

export type PmsCalendarAutoOpenResult = {
  candidate: PmsCalendarAutoOpenCandidate;
  createdNewJob: boolean;
  eventKey: string;
  jobKey: string;
};

export type PmsCalendarAutoOpenFailure = {
  propertyId: string;
  stage: "selection" | "enqueue";
  message: string;
};

export type PmsCalendarAutoOpenSelection = {
  candidates: PmsCalendarAutoOpenCandidate[];
  failures: PmsCalendarAutoOpenFailure[];
};

export type PmsChannexSchedulerOptions = {
  now?: Date;
  workerId?: string;
  limit?: number;
};

export type PgPmsChannexSchedulerStoreConfig = {
  connectionString: string;
  max?: number;
};

/** The scheduler store: auto-open selection and enqueue. It has no Channex path. */
export type PmsCalendarAutoOpenSchedulerStore = {
  findCalendarAutoOpenCandidates(now: Date, limit: number): Promise<PmsCalendarAutoOpenSelection>;
  enqueueCalendarAutoOpenJob(
    candidate: PmsCalendarAutoOpenCandidate,
    context: PmsChannexSchedulerContext,
  ): Promise<PmsCalendarAutoOpenResult>;
};

/** One scheduler run's database session; every query runs on the connection holding the lock. */
export type PmsCalendarAutoOpenSchedulerSession = PmsCalendarAutoOpenSchedulerStore & {
  readSelectionStats(): Promise<PmsCalendarAutoOpenSelectionStats>;
};

export type PmsCalendarAutoOpenSelectionStats = Readonly<{
  /** Properties whose effective setting is enabled (saved, or the virtual default). */
  enabledSettings: number;
  /** Of those, the ones paused until calendar and room setup are ready. */
  pausedNotReady: number;
  /** Of those, the ones the selection skips because an active room's label is unverified. */
  skippedUnverifiedLabels: number;
}>;

export type PgPmsCalendarAutoOpenSchedulerStore = {
  /**
   * Runs `run` on one connection that holds a database-wide session advisory lock, so
   * overlapping API tasks (for example during a rolling deploy) never scan at the same time.
   * Returns `{ ran: false }` without running when another session holds the lock.
   */
  withRunLock<T>(
    run: (session: PmsCalendarAutoOpenSchedulerSession) => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }>;
  close(): Promise<void>;
};

export const PMS_CALENDAR_AUTO_OPEN_SCHEDULER_LOCK = "pms.calendar-auto-open.scheduler";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type CalendarSourceRow = {
  propertyId: string;
  organizationId: string | null;
  settingRevision: number | string;
  mode: "rolling" | "fixed";
  rollingMonths: number | string | null;
  fixedEndMonth: string | Date | null;
  propertyProfileRevision: number | string;
  propertyTimeZone: string | null;
  operatingCalendarRevision: number | string | null;
  rooms: Array<{
    roomTypeId: string;
    roomFactsRevision: number | string;
    roomUnitsRevision: number | string;
  }>;
  pricingCurrencyRevision: number | string | null;
  flexibleRatePlans: Array<{
    roomTypeId: string;
    flexibleRatePlanRevision: number | string;
  }>;
  optionalPricingAggregateRevision: number | string | null;
  generatedCoverageFrom: string | Date | null;
  generatedCoverageThrough: string | Date | null;
  roomAdditionStoredThrough: string | Date | null;
  successfulApplications: Array<{
    sourceFingerprint: string;
    openThrough: string;
  }>;
};

export type PmsChannexSchedulerRunResult = {
  name: PmsChannexSchedulerRunName;
  scanned: number;
  enqueued: number;
  reused: number;
  autoOpenEnqueued: number;
  autoOpenFailures: PmsCalendarAutoOpenFailure[];
};

/** A pool-backed scheduler store without the run lock; the API uses the locked store below. */
export function createPgPmsChannexSchedulerStore(
  config: PgPmsChannexSchedulerStoreConfig,
): PmsCalendarAutoOpenSchedulerStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findCalendarAutoOpenCandidates(now, limit) {
      return selectCalendarAutoOpenCandidates(pool, now, limit);
    },
    async enqueueCalendarAutoOpenJob(candidate, context) {
      return enqueuePgCalendarAutoOpenJob(pool, candidate, context);
    },
    async close() {
      await pool.end();
    },
  };
}

export function createPgPmsCalendarAutoOpenSchedulerStore(config: {
  connectionString: string;
}): PgPmsCalendarAutoOpenSchedulerStore {
  // Pools are shared and sized by the API's Postgres runtime; a run needs one connection.
  const pool = new pg.Pool({ connectionString: config.connectionString });

  return {
    async withRunLock(run) {
      const client = await pool.connect();
      // A checked-out client whose connection drops while idle emits "error"; unhandled, that
      // would crash the API. Such a client is discarded instead of returned to the pool.
      let discard = true;
      const onError = () => {
        discard = true;
      };
      client.on("error", onError);
      let holdsLock = false;
      try {
        const locked = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [PMS_CALENDAR_AUTO_OPEN_SCHEDULER_LOCK],
        );
        discard = false;
        holdsLock = locked.rows[0]?.locked === true;
        if (!holdsLock) return { ran: false };
        return {
          ran: true,
          value: await run({
            findCalendarAutoOpenCandidates: (now, limit) =>
              selectCalendarAutoOpenCandidates(client, now, limit),
            enqueueCalendarAutoOpenJob: (candidate, context) =>
              enqueueCalendarAutoOpenJobOnClient(client, candidate, context),
            readSelectionStats: () => readCalendarAutoOpenSelectionStats(client),
          }),
        };
      } finally {
        if (holdsLock) {
          try {
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
              PMS_CALENDAR_AUTO_OPEN_SCHEDULER_LOCK,
            ]);
          } catch {
            // Keep the run's own result or error; ending the session releases the lock.
            discard = true;
          }
        }
        client.removeListener("error", onError);
        client.release(discard);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/**
 * Properties whose effective auto-open setting is enabled (an enabled saved setting, or no saved
 * setting: the virtual default, revision 0), excluding suspended and retired hotels. `ready`
 * says whether setup lets the worker apply a job. Every property needs a timezone, pricing
 * settings, an active room type and an operating calendar. The default also needs a calendar
 * current for the profile, timezone and room bindings, and no closed room type. A property that
 * is not ready is paused (counted, not a failure), so half-onboarded hotels don't warn hourly.
 * Placeholders `$first` to `$first + 2` bind effectiveCalendarAutoOpenDefaultParams.
 */
function effectiveCalendarAutoOpenSettingsSql(first: number): string {
  const [mode, rollingMonths, enabled] = [first, first + 1, first + 2].map((n) => `$${n}`);
  return `SELECT
       property.id AS property_id,
       COALESCE(stored.revision, 0) AS revision,
       COALESCE(stored.mode, ${mode}::text) AS mode,
       CASE WHEN stored.property_id IS NULL THEN ${rollingMonths}::smallint
            ELSE stored.rolling_months END AS rolling_months,
       stored.fixed_end_month,
       (
           EXISTS (
             SELECT 1 FROM hotel_catalog.property_locations location
             WHERE location.property_id = property.id AND location.timezone IS NOT NULL
           )
           AND EXISTS (
             SELECT 1 FROM pms.property_pricing_settings pricing
             WHERE pricing.property_id = property.id
               AND pricing.pricing_currency_revision IS NOT NULL
               AND pricing.optional_pricing_aggregate_revision IS NOT NULL
           )
           AND EXISTS (
             SELECT 1 FROM pms.room_types room
             WHERE room.property_id = property.id AND room.active IS TRUE
           )
           AND EXISTS (
             SELECT 1 FROM pms.operating_calendar_revisions revision
             WHERE revision.property_id = property.id
           )
           AND (
           -- A saved setting keeps its existing behaviour on stale calendar sources. The default
           -- additionally waits until the worker can apply the job.
           stored.property_id IS NOT NULL
           OR (
             EXISTS (
               -- The current calendar was saved for the current time zone; a new time zone needs
               -- a re-save. Other profile edits keep it current (VAY-2150).
               SELECT 1
               FROM pms.operating_calendar_revisions latest
               JOIN hotel_catalog.property_locations location
                 ON location.property_id = latest.property_id
               WHERE latest.property_id = property.id
                 AND latest.calendar_revision = (
                   SELECT max(revision.calendar_revision) FROM pms.operating_calendar_revisions revision
                   WHERE revision.property_id = property.id
                 )
                 AND latest.property_time_zone = location.timezone
             )
             AND NOT EXISTS (
               -- A closed room type stays active but leaves the calendar's room bindings.
               SELECT 1
               FROM pms.room_type_closures closure
               JOIN pms.room_types room
                 ON room.property_id = closure.property_id
                AND room.id = closure.room_type_id
                AND room.active IS TRUE
               WHERE closure.property_id = property.id
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pms.room_types room
               LEFT JOIN pms.operating_calendar_room_bindings binding
                 ON binding.property_id = room.property_id
                AND binding.room_type_id = room.id
                AND binding.calendar_revision = (
                  SELECT max(revision.calendar_revision) FROM pms.operating_calendar_revisions revision
                  WHERE revision.property_id = property.id
                )
               WHERE room.property_id = property.id AND room.active IS TRUE
                 AND NOT EXISTS (
                   SELECT 1 FROM pms.room_type_closures closure
                   WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
                 )
                 AND (
                   binding.room_type_id IS NULL
                   OR binding.source_room_units_revision IS DISTINCT FROM room.room_units_revision
                 )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pms.operating_calendar_room_bindings binding
               LEFT JOIN pms.room_types room
                 ON room.property_id = binding.property_id
                AND room.id = binding.room_type_id
                AND room.active IS TRUE
                AND NOT EXISTS (
                  SELECT 1 FROM pms.room_type_closures closure
                  WHERE closure.property_id = room.property_id AND closure.room_type_id = room.id
                )
               WHERE binding.property_id = property.id
                 AND binding.calendar_revision = (
                   SELECT max(revision.calendar_revision) FROM pms.operating_calendar_revisions revision
                   WHERE revision.property_id = property.id
                 )
                 AND room.id IS NULL
             )
           )
         )
       ) AS ready
     FROM hotel_catalog.properties property
     LEFT JOIN pms.calendar_auto_open_settings stored ON stored.property_id = property.id
     WHERE COALESCE(stored.enabled, ${enabled}::boolean) IS TRUE
       AND property.lifecycle_status IN ('provisioning', 'active')`;
}

function effectiveCalendarAutoOpenDefaultParams(): [string, number | null, boolean] {
  const defaults = PMS_CALENDAR_AUTO_OPEN_DEFAULT_CONFIGURATION;
  return [defaults.mode, defaults.rollingMonths, defaults.enabled];
}

async function readCalendarAutoOpenSelectionStats(
  queryable: Queryable,
): Promise<PmsCalendarAutoOpenSelectionStats> {
  const result = await queryable.query<PmsCalendarAutoOpenSelectionStats>(
    `WITH effective AS (${effectiveCalendarAutoOpenSettingsSql(1)})
     SELECT
       count(*)::int AS "enabledSettings",
       count(*) FILTER (WHERE NOT effective.ready)::int AS "pausedNotReady",
       count(*) FILTER (
         WHERE effective.ready AND EXISTS (
           SELECT 1
           FROM pms.rooms physical_room
           JOIN pms.room_types room_type
             ON room_type.property_id=physical_room.property_id
            AND room_type.id=physical_room.room_type_id
            AND room_type.active IS TRUE
           WHERE physical_room.property_id=effective.property_id
             AND physical_room.status<>'retired'
             AND (
               physical_room.operational_label_status<>'verified'
               OR physical_room.room_number IS NULL
             )
         )
       )::int AS "skippedUnverifiedLabels"
     FROM effective`,
    effectiveCalendarAutoOpenDefaultParams(),
  );
  return result.rows[0] ?? { enabledSettings: 0, pausedNotReady: 0, skippedUnverifiedLabels: 0 };
}

/** Enqueues calendar auto-open jobs and nothing else; it takes no Channex provider. */
export async function runPmsCalendarAutoOpenScheduler(
  store: PmsCalendarAutoOpenSchedulerStore,
  options: PmsChannexSchedulerOptions = {},
): Promise<PmsChannexSchedulerRunResult> {
  const now = options.now ?? new Date();
  return runCalendarAutoOpen(store, {
    now,
    context: {
      now,
      workerId: options.workerId ?? "pms-calendar-auto-open-scheduler",
      correlationId: `pms.calendar-auto-open.scheduler:${now.toISOString()}`,
    },
    limit: options.limit ?? DEFAULT_PMS_CHANNEX_LIMIT,
  });
}

export function buildCalendarAutoOpenEventKey(input: {
  propertyId: string;
  openThrough: string;
  sourceFingerprint: string;
}): string {
  return `pms.calendar-auto-open:${input.propertyId}:${input.openThrough}:source-${input.sourceFingerprint}:v2`;
}

export function buildCalendarAutoOpenJobKey(input: {
  propertyId: string;
  openThrough: string;
  sourceFingerprint: string;
}): string {
  return `pms.calendar-auto-open:property:${input.propertyId}:open-through-${input.openThrough}:source-${input.sourceFingerprint}:v2`;
}

async function selectCalendarAutoOpenCandidates(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PmsCalendarAutoOpenSelection> {
  if (!Number.isSafeInteger(limit) || limit < 1) return { candidates: [], failures: [] };
  const selected: PmsCalendarAutoOpenCandidate[] = [];
  const failures: PmsCalendarAutoOpenFailure[] = [];
  let afterPropertyId: string | null = null;

  while (selected.length < limit) {
    const page: { rows: CalendarSourceRow[] } = await queryable.query<CalendarSourceRow>(
      `WITH effective AS (${effectiveCalendarAutoOpenSettingsSql(3)}),
       candidate_properties AS (
         SELECT effective.*
         FROM effective
         WHERE effective.ready
           AND NOT EXISTS (
             SELECT 1
             FROM pms.rooms physical_room
             JOIN pms.room_types room_type
               ON room_type.property_id=physical_room.property_id
              AND room_type.id=physical_room.room_type_id
              AND room_type.active IS TRUE
             WHERE physical_room.property_id=effective.property_id
               AND physical_room.status<>'retired'
               AND (
                 physical_room.operational_label_status<>'verified'
                 OR physical_room.room_number IS NULL
               )
           )
           AND ($1::uuid IS NULL OR effective.property_id > $1::uuid)
         ORDER BY effective.property_id
         LIMIT $2
       )
       SELECT
         setting.property_id::text AS "propertyId",
         calendar.organization_id::text AS "organizationId",
         setting.revision AS "settingRevision",
         setting.mode,
         setting.rolling_months AS "rollingMonths",
         setting.fixed_end_month AS "fixedEndMonth",
         -- The calendar's own profile and room-facts pins, so detail edits don't change the job
         -- source and re-run auto-open (VAY-2150).
         calendar.property_profile_revision AS "propertyProfileRevision",
         location.timezone AS "propertyTimeZone",
         calendar.calendar_revision AS "operatingCalendarRevision",
         room_source.rooms,
         pricing.pricing_currency_revision AS "pricingCurrencyRevision",
         plan_source.plans AS "flexibleRatePlans",
         pricing.optional_pricing_aggregate_revision AS "optionalPricingAggregateRevision",
         coverage.coverage_from AS "generatedCoverageFrom",
         coverage.coverage_through AS "generatedCoverageThrough",
         CASE WHEN EXISTS (
           SELECT 1
           FROM pms.inventory_materialization_coverage stored
           JOIN pms.operating_calendar_room_bindings room
             ON room.property_id = stored.property_id
            AND room.calendar_revision = calendar.calendar_revision
           WHERE stored.property_id = setting.property_id
             AND stored.calendar_revision < calendar.calendar_revision
             AND NOT EXISTS (
               SELECT 1
               FROM pms.operating_calendar_room_bindings materialized
               WHERE materialized.property_id = stored.property_id
                 AND materialized.calendar_revision = stored.calendar_revision
                 AND materialized.room_type_id = room.room_type_id
             )
         ) THEN (
           SELECT max(day.stay_date) FROM pms.inventory_days day
           WHERE day.property_id = setting.property_id
         ) END AS "roomAdditionStoredThrough",
         successful_application.applications AS "successfulApplications"
       FROM candidate_properties setting
       JOIN hotel_catalog.properties property ON property.id = setting.property_id
       LEFT JOIN hotel_catalog.property_locations location
         ON location.property_id = setting.property_id
       LEFT JOIN pms.property_pricing_settings pricing
         ON pricing.property_id = setting.property_id
       LEFT JOIN LATERAL (
         SELECT revision.organization_id, revision.calendar_revision,
                revision.property_profile_revision
         FROM pms.operating_calendar_revisions revision
         WHERE revision.property_id = setting.property_id
         ORDER BY revision.calendar_revision DESC
         LIMIT 1
       ) calendar ON TRUE
       JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'roomTypeId', room_type.id::text,
             'roomFactsRevision', COALESCE(
               binding.source_room_facts_revision, room_type.room_facts_revision
             ),
             'roomUnitsRevision', room_type.room_units_revision
           ) ORDER BY room_type.id),
           '[]'::json
         ) AS rooms
         FROM pms.room_types room_type
         LEFT JOIN pms.operating_calendar_room_bindings binding
           ON binding.property_id = room_type.property_id
          AND binding.room_type_id = room_type.id
          AND binding.calendar_revision = calendar.calendar_revision
         WHERE room_type.property_id = setting.property_id AND room_type.active IS TRUE
       ) room_source ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'roomTypeId', plan.room_type_id::text,
             'flexibleRatePlanRevision', plan.flexible_rate_plan_revision
           ) ORDER BY plan.room_type_id),
           '[]'::json
         ) AS plans
         FROM (
           -- A pricing-v2 publication replaces the retired legacy plans (same rule as the
           -- auto-open worker): a room with a published offer has a rate, at a constant
           -- revision so price edits do not re-run auto-open.
           SELECT legacy.room_type_id, legacy.flexible_rate_plan_revision
           FROM pms.rate_plans legacy
           WHERE legacy.property_id = setting.property_id
             AND legacy.pricing_contract_version = 'pms-pricing.v1'
             AND NOT EXISTS (
               SELECT 1 FROM pms.pricing_v2_heads head
               WHERE head.property_id = setting.property_id AND head.revision > 0
             )
           UNION ALL
           SELECT published.room_type_id, 1
           FROM pms.pricing_v2_heads head
           JOIN pms.pricing_v2_rooms published
             ON published.property_id = head.property_id AND published.revision = head.revision
           WHERE head.property_id = setting.property_id
             AND jsonb_array_length(published.configuration->'offers') > 0
         ) plan
         JOIN pms.room_types room_type
           ON room_type.id = plan.room_type_id
          AND room_type.property_id = setting.property_id
          AND room_type.active IS TRUE
       ) plan_source ON TRUE
       LEFT JOIN pms.inventory_materialization_coverage coverage
         ON coverage.property_id = setting.property_id
        AND coverage.calendar_revision = calendar.calendar_revision
       JOIN LATERAL (
         SELECT COALESCE(
           json_agg(json_build_object(
             'sourceFingerprint', job.payload ->> 'sourceFingerprint',
             'openThrough', job.payload ->> 'openThrough'
           )),
           '[]'::json
         ) AS applications
         FROM platform.jobs job
         WHERE job.property_id = setting.property_id
           AND job.queue_name = 'pms.inventory.scheduler'
           AND job.job_type = 'pms.calendar-auto-open'
           AND job.status = 'succeeded'
           AND job.resource_product = 'pms'
           AND job.resource_type = 'property'
           AND job.resource_id = setting.property_id::text
       ) successful_application ON TRUE
       ORDER BY setting.property_id`,
      [afterPropertyId, limit, ...effectiveCalendarAutoOpenDefaultParams()],
    );
    if (page.rows.length === 0) break;
    afterPropertyId = page.rows.at(-1)!.propertyId;

    const candidates = page.rows.flatMap((row) => {
      try {
        const candidate = calendarCandidateFromSourceRow(row, now);
        return candidate ? [candidate] : [];
      } catch (error) {
        failures.push({
          propertyId: row.propertyId,
          stage: "selection",
          message: errorMessage(error),
        });
        return [];
      }
    });
    const existing = await existingCalendarAutoOpenJobKeys(
      queryable,
      candidates.map(buildCalendarAutoOpenJobKey),
    );
    for (const candidate of candidates) {
      if (!existing.has(buildCalendarAutoOpenJobKey(candidate))) selected.push(candidate);
      if (selected.length === limit) break;
    }
    if (page.rows.length < limit) break;
  }

  return { candidates: selected, failures };
}

async function existingCalendarAutoOpenJobKeys(
  queryable: Queryable,
  jobKeys: readonly string[],
): Promise<Set<string>> {
  if (jobKeys.length === 0) return new Set();
  const result = await queryable.query<{ jobKey: string }>(
    `SELECT job_key AS "jobKey"
     FROM platform.jobs
     WHERE queue_name = $1 AND job_key = ANY($2::text[])`,
    [PMS_CALENDAR_AUTO_OPEN_QUEUE, jobKeys],
  );
  return new Set(result.rows.map(({ jobKey }) => jobKey));
}

async function enqueuePgCalendarAutoOpenJob(
  pool: pg.Pool,
  candidate: PmsCalendarAutoOpenCandidate,
  context: PmsChannexSchedulerContext,
): Promise<PmsCalendarAutoOpenResult> {
  const client = await pool.connect();
  try {
    return await enqueueCalendarAutoOpenJobOnClient(client, candidate, context);
  } finally {
    client.release();
  }
}

async function enqueueCalendarAutoOpenJobOnClient(
  client: pg.PoolClient,
  candidate: PmsCalendarAutoOpenCandidate,
  context: PmsChannexSchedulerContext,
): Promise<PmsCalendarAutoOpenResult> {
  const eventKey = buildCalendarAutoOpenEventKey(candidate);
  const jobKey = buildCalendarAutoOpenJobKey(candidate);
  const keyHash = sha256Key(jobKey);
  const payload = {
    propertyId: candidate.propertyId,
    organizationId: candidate.organizationId,
    openFrom: candidate.openFrom,
    openThrough: candidate.openThrough,
    roomTypeIds: candidate.roomTypeIds,
    generatedCoverageThrough: candidate.generatedCoverageThrough,
    source: candidate.source,
    sourceFingerprint: candidate.sourceFingerprint,
  };

  try {
    await client.query("BEGIN");
    await insertOrTouchIdempotencyKey(client, {
      operation: "calendar_auto_open",
      keyHash,
      requestFingerprintHash: sha256Key(stableJson(payload)),
      responseResourceType: "property",
      responseResourceId: candidate.propertyId,
      candidate,
      context,
      metadata: { eventKey, jobKey, source: "pms-calendar-auto-open-scheduler" },
    });
    const domainEventId = await insertOrFindPmsDomainEvent(client, {
      eventKey,
      eventType: "pms.calendar-auto-open",
      propertyId: candidate.propertyId,
      resourceType: "property",
      resourceId: candidate.propertyId,
      keyHash,
      payload,
      context,
      metadata: { source: "pms-calendar-auto-open-scheduler" },
    });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform.jobs
         (
           job_key,
           queue_name,
           job_type,
           source_domain_event_id,
           status,
           attempts_count,
           max_attempts,
           run_after,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           correlation_id,
           idempotency_key_hash,
           payload,
           job_metadata
         )
       VALUES (
         $1,
         $2,
         'pms.calendar-auto-open',
         $3::uuid,
         'pending',
         0,
         $4,
         $5::timestamptz,
         'property',
         $6::uuid,
         'pms',
         'property',
         $6,
         $7,
         $8,
         $9::jsonb,
         $10::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id`,
      [
        jobKey,
        PMS_CALENDAR_AUTO_OPEN_QUEUE,
        domainEventId,
        CALENDAR_AUTO_OPEN_MAX_ATTEMPTS,
        context.now.toISOString(),
        candidate.propertyId,
        candidate.correlationId ?? context.correlationId,
        keyHash,
        JSON.stringify(payload),
        JSON.stringify({ source: "pms-calendar-auto-open-scheduler" }),
      ],
    );
    await client.query("COMMIT");
    return { candidate, createdNewJob: Boolean(inserted.rows[0]), eventKey, jobKey };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function runCalendarAutoOpen(
  store: PmsCalendarAutoOpenSchedulerStore,
  input: {
    now: Date;
    context: PmsChannexSchedulerContext;
    limit: number;
  },
): Promise<PmsChannexSchedulerRunResult> {
  const selection = await store.findCalendarAutoOpenCandidates(input.now, input.limit);
  const run = emptyRun("calendarAutoOpen", selection.candidates.length + selection.failures.length);
  run.autoOpenFailures.push(...selection.failures);

  for (const candidate of selection.candidates) {
    try {
      const result = await store.enqueueCalendarAutoOpenJob(candidate, input.context);
      if (result.createdNewJob) {
        run.enqueued += 1;
        run.autoOpenEnqueued += 1;
      } else {
        run.reused += 1;
      }
    } catch (error) {
      run.autoOpenFailures.push({
        propertyId: candidate.propertyId,
        stage: "enqueue",
        message: errorMessage(error),
      });
    }
  }

  return run;
}

function emptyRun(name: PmsChannexSchedulerRunName, scanned: number): PmsChannexSchedulerRunResult {
  return {
    name,
    scanned,
    enqueued: 0,
    reused: 0,
    autoOpenEnqueued: 0,
    autoOpenFailures: [],
  };
}

async function insertOrTouchIdempotencyKey(
  client: pg.PoolClient,
  input: {
    operation: string;
    keyHash: string;
    requestFingerprintHash: string;
    responseResourceType: string;
    responseResourceId: string;
    candidate: { propertyId: string; organizationId: string };
    context: PmsChannexSchedulerContext;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         property_id,
         response_status_code,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         response_body_hash,
         correlation_id,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'completed',
       'property',
       $4::uuid,
       202,
       'pms',
       $5,
       $6,
       $3,
       $7,
       $8::timestamptz,
       $9::timestamptz,
       $10::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       completed_at = COALESCE(platform.idempotency_keys.completed_at, EXCLUDED.completed_at),
       idempotency_metadata = platform.idempotency_keys.idempotency_metadata || EXCLUDED.idempotency_metadata`,
    [
      input.operation,
      input.keyHash,
      input.requestFingerprintHash,
      input.candidate.propertyId,
      input.responseResourceType,
      input.responseResourceId,
      input.context.correlationId,
      input.context.now.toISOString(),
      new Date(input.context.now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        ...input.metadata,
        organizationId: input.candidate.organizationId,
      }),
    ],
  );
}

async function insertOrFindPmsDomainEvent(
  client: pg.PoolClient,
  input: {
    eventKey: string;
    eventType: string;
    propertyId: string;
    resourceType: string;
    resourceId: string;
    keyHash: string;
    payload: Record<string, unknown>;
    context: PmsChannexSchedulerContext;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         occurred_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES (
       'pms',
       $1,
       $2,
       $3::timestamptz,
       'property',
       $4::uuid,
       'pms',
       $5,
       $6,
       'system',
       $7,
       $1,
       $8,
       $9::jsonb,
       $10::jsonb,
       'internal'
     )
     ON CONFLICT (source_system, event_key) DO NOTHING
     RETURNING id`,
    [
      input.eventKey,
      input.eventType,
      input.context.now.toISOString(),
      input.propertyId,
      input.resourceType,
      input.resourceId,
      input.context.correlationId,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.metadata),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.domain_events
     WHERE source_system = 'pms' AND event_key = $1
     LIMIT 1`,
    [input.eventKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve PMS domain event ${input.eventKey}`);
  }
  return existingId;
}

function calendarCandidateFromSourceRow(
  row: CalendarSourceRow,
  now: Date,
): PmsCalendarAutoOpenCandidate | null {
  if (!row.organizationId || !row.propertyTimeZone) {
    throw new Error("PMS calendar auto-open property source is incomplete");
  }
  // Revision 0 is the virtual default of a property with no saved setting.
  const revision =
    Number(row.settingRevision) === 0 ? 0 : positiveDatabaseInteger(row.settingRevision);
  const rollingMonths =
    row.rollingMonths === null ? null : positiveDatabaseInteger(row.rollingMonths);
  const fixedEndMonth = row.fixedEndMonth === null ? null : dateOnly(row.fixedEndMonth).slice(0, 7);
  if (
    (row.mode === "rolling" && ![12, 18, 24].includes(rollingMonths ?? 0)) ||
    (row.mode === "fixed" && fixedEndMonth === null)
  ) {
    throw new Error("PMS calendar auto-open setting source is invalid");
  }
  const setting = {
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId: row.propertyId,
    revision,
    enabled: true,
    mode: row.mode,
    rollingMonths: row.mode === "rolling" ? (rollingMonths as 12 | 18 | 24) : null,
    fixedEndMonth: row.mode === "fixed" ? fixedEndMonth : null,
    updatedAt: null,
  } as const;
  const horizon = calculatePmsCalendarAutoOpenHorizon(setting, row.propertyTimeZone, now);
  if (!isPmsCalendarAutoOpenFixedTargetWithinLimit(setting, row.propertyTimeZone, now)) {
    throw new Error("PMS calendar auto-open fixed target exceeds the 24-month maximum");
  }
  if (!horizon.targetOpenThrough || horizon.targetOpenThrough < horizon.propertyLocalDate)
    return null;
  // Stored days from today on lack an added room until setup materializes the calendar, and
  // opening dates before then fails on that gap; the next run after it picks this up (VAY-2138).
  if (
    row.roomAdditionStoredThrough &&
    dateOnly(row.roomAdditionStoredThrough) >= horizon.propertyLocalDate
  ) {
    return null;
  }

  const source = createPmsCalendarAutoOpenSource({
    settingRevision: revision,
    propertyProfileRevision: positiveDatabaseInteger(row.propertyProfileRevision),
    propertyTimeZone: row.propertyTimeZone,
    operatingCalendarRevision: positiveDatabaseInteger(row.operatingCalendarRevision),
    rooms: row.rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: positiveDatabaseInteger(room.roomFactsRevision),
      roomUnitsRevision: positiveDatabaseInteger(room.roomUnitsRevision),
    })),
    pricing: {
      pricingCurrencyRevision: positiveDatabaseInteger(row.pricingCurrencyRevision),
      flexibleRatePlans: row.flexibleRatePlans.map((plan) => ({
        roomTypeId: plan.roomTypeId,
        flexibleRatePlanRevision: positiveDatabaseInteger(plan.flexibleRatePlanRevision),
      })),
      optionalPricingAggregateRevision: nonNegativeDatabaseInteger(
        row.optionalPricingAggregateRevision,
      ),
    },
  });
  const sourceFingerprint = fingerprintPmsCalendarAutoOpenSource(source);
  const generatedCoverageFrom = row.generatedCoverageFrom
    ? dateOnly(row.generatedCoverageFrom)
    : null;
  const generatedCoverageThrough = row.generatedCoverageThrough
    ? dateOnly(row.generatedCoverageThrough)
    : null;
  const sourcesReflected = row.successfulApplications.some(
    (application) =>
      application.sourceFingerprint === sourceFingerprint &&
      /^\d{4}-\d{2}-\d{2}$/.test(application.openThrough) &&
      application.openThrough >= horizon.targetOpenThrough!,
  );
  if (
    generatedCoverageFrom &&
    generatedCoverageFrom <= horizon.propertyLocalDate &&
    generatedCoverageThrough &&
    generatedCoverageThrough >= horizon.targetOpenThrough &&
    sourcesReflected
  ) {
    return null;
  }

  return {
    propertyId: row.propertyId,
    organizationId: row.organizationId,
    openFrom: horizon.propertyLocalDate,
    openThrough: horizon.targetOpenThrough,
    roomTypeIds: source.rooms.map(({ roomTypeId }) => roomTypeId),
    generatedCoverageThrough,
    source,
    sourceFingerprint,
    correlationId: `pms.calendar-auto-open:${row.propertyId}:${horizon.targetOpenThrough}:source-${sourceFingerprint}`,
  };
}

function dateOnly(value: Date | string): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
      value.getDate(),
    ).padStart(2, "0")}`;
  }
  return value.slice(0, 10);
}

function positiveDatabaseInteger(value: number | string | null): number {
  if (value === null) throw new Error("PMS calendar auto-open source revision is missing");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("PMS calendar auto-open source revision is invalid");
  }
  return parsed;
}

function nonNegativeDatabaseInteger(value: number | string | null): number {
  if (value === null)
    throw new Error("PMS calendar auto-open pricing aggregate revision is missing");
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("PMS calendar auto-open pricing aggregate revision is invalid");
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown PMS calendar auto-open failure";
}

function sha256Key(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}
