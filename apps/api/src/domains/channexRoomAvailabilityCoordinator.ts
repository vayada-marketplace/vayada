import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { PMS_INVENTORY_HORIZON_MAX_DAYS } from "@vayada/domain-pms";
import { observeChannexAvailabilityDate } from "../integrations/channexAvailabilityReadback.js";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import {
  addDays,
  CHANNEX_CUT_OFF_MAX_DAYS,
  channexCutOffClosedDates,
  readChannexPropertyCutOff,
} from "../integrations/channexPropertyCutOff.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";
import { prepareChannexRoomAvailabilityDispatch } from "./channexRoomAvailabilityDispatch.js";
import { boundedProviderCall } from "./channexRoomAvailabilityEvidence.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

type Inventory = Pick<
  PmsInventoryMaterializationRepository,
  "getCurrentInventoryDay" | "getInventoryLaunchReadiness"
>;

type Scope = Readonly<{
  propertyId: string;
  connectionId: string;
  externalPropertyId: string;
  externalRoomTypeIds: readonly string[];
  bindingGeneration: string;
  localToday: string;
  through: string;
  roomCount: number;
  dayCount: number;
  fullPropertyReadinessRequired: boolean;
}>;

type ChannexRead = (path: string, signal: AbortSignal) => Promise<unknown>;

// A cut-off closes at most 30 dates after Channex's date, which is at most two days after the
// hotel's own (the two time zones may differ).
const CUT_OFF_REACH_DAYS = CHANNEX_CUT_OFF_MAX_DAYS + 2;
// Each closed night is confirmed with one bounded read; a longer closure than this is sent as
// before, so the reads stay well inside the job's lease.
const CUT_OFF_CONFIRMED_NIGHTS = 7;

/**
 * VAY-2108: whether the property's Channex cut-off has closed `date`, by the same rule the send
 * step skips nights with, so the two never disagree about a night (a disagreement would resend it
 * on every run). Read-only.
 */
export async function channexCutOffClosesNight(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  date: string,
  get: ChannexRead,
  now: () => Date = () => new Date(),
) {
  const lease = { ...input };
  const scope = await readScope(pool, lease, false);
  if (scope.kind !== "scope" || date > addDays(scope.value.localToday, CUT_OFF_REACH_DAYS))
    return false;
  const openFrom = await channexCutOffOpenFrom(scope.value, date, get, now, lease);
  return openFrom !== null && date < openFrom;
}

/**
 * The Channex dates the property's cut-off closes now. Channex ignores availability for them
 * while its task still reports success, so a send can never read back. Read-only.
 */
async function readChannexAvailabilityClosedDates(
  externalPropertyId: string,
  get: ChannexRead,
  now: () => Date,
) {
  const cutOff = await boundedProviderCall((signal) =>
    readChannexPropertyCutOff(externalPropertyId, (_method, path) => {
      signal.throwIfAborted();
      return get(path, signal);
    }),
  );
  return channexCutOffClosedDates(cutOff, now());
}

/**
 * VAY-2108: the first night to send when the property's cut-off has closed the nights before it,
 * or null to send as usual. Only nights Channex itself shows as 0 for every room are skipped, so a
 * wrong reading of the cut-off never leaves a sellable night stale; an unreadable property or
 * night is sent as usual (as before this rule).
 */
async function channexCutOffOpenFrom(
  scope: Scope,
  selectedDate: string,
  get: ChannexRead,
  now: () => Date,
  lease: ChannexPricingJobLeaseInput,
) {
  try {
    const closed = await readChannexAvailabilityClosedDates(scope.externalPropertyId, get, now);
    if (!closed || closed.through < selectedDate) return null;
    if (closed.through > addDays(scope.localToday, CUT_OFF_CONFIRMED_NIGHTS - 1)) return null;
    for (let date = scope.localToday; date <= closed.through; date = addDays(date, 1)) {
      const night = date;
      const count = await boundedProviderCall((signal) =>
        observeChannexAvailabilityDate(scope.externalPropertyId, night, (_method, path) => {
          signal.throwIfAborted();
          return get(path, signal);
        }),
      );
      if (!scope.externalRoomTypeIds.every((room) => count(room) === 0)) return null;
    }
    return addDays(closed.through, 1);
  } catch (error) {
    console.warn("Channex cut-off unavailable; its nights are treated as open.", {
      jobId: lease.jobId,
      attemptNumber: lease.attemptNumber,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/** Rechecks complete room availability evidence inside a caller-owned activation transaction. */
export async function lockCurrentChannexRoomAvailability(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    propertyId: string;
    connectionId: string;
    externalPropertyId: string;
    bindingGeneration: string;
    roomTypeId: string;
    /** The sync's first open night (after a Channex cut-off); never before the hotel's today. */
    from?: string;
  }>,
) {
  await lockPmsInventoryMutationScope(client, input.propertyId);
  const mappings = await client.query<{ bindingGeneration: string }>(
    `SELECT c.binding_generation::text AS "bindingGeneration"
     FROM pms.channel_room_type_mappings m
     JOIN pms.channel_connections c
       ON c.id=m.connection_id AND c.property_id=m.property_id
     JOIN pms.room_types r ON r.id=m.room_type_id AND r.property_id=m.property_id
     WHERE m.property_id=$1 AND m.connection_id=$2 AND m.status='active' AND r.active
       AND c.connection_status='connected' AND c.external_property_id=$3
       AND c.binding_generation=$4::uuid
       AND m.room_type_id=$5::uuid
       AND m.external_room_type_id<>'' AND m.external_room_type_id=btrim(m.external_room_type_id)
       AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closed
         WHERE closed.property_id=r.property_id AND closed.room_type_id=r.id)
     ORDER BY m.room_type_id::text COLLATE "C",m.id
     FOR SHARE OF m,c,r NOWAIT`,
    [
      input.propertyId,
      input.connectionId,
      input.externalPropertyId,
      input.bindingGeneration,
      input.roomTypeId,
    ],
  );
  if (!mappings.rows.length) return unavailable("room_availability_mapping_unavailable");
  const coverage = (
    await client.query<{ through: string; materializedRevision: number; timeZone: string }>(
      `SELECT coverage.coverage_through::text AS through,
         coverage.materialized_revision AS "materializedRevision",
         calendar.property_time_zone AS "timeZone"
       FROM pms.inventory_materialization_coverage coverage
       JOIN pms.operating_calendar_revisions calendar
         ON calendar.property_id=coverage.property_id
        AND calendar.calendar_revision=coverage.calendar_revision
       WHERE coverage.property_id=$1
         AND coverage.calendar_revision=coverage.materialized_revision
         AND coverage.materialized_day_count=coverage.expected_day_count
       FOR SHARE OF coverage,calendar NOWAIT`,
      [input.propertyId],
    )
  ).rows[0];
  if (
    coverage &&
    !(await lockSelectedRoomMaterializationCurrent(
      client,
      input.propertyId,
      input.roomTypeId,
      coverage.materializedRevision,
    ))
  )
    return unavailable("room_availability_coverage_unavailable");
  const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const localToday = coverage && now ? channexPropertyLocalDate(coverage.timeZone, now) : null;
  const horizon = coverage && localToday ? availabilityWindow(localToday, coverage.through) : null;
  const from = localToday ? windowStart(localToday, input.from) : null;
  if (!coverage || !localToday || !horizon || !from)
    return unavailable("room_availability_coverage_unavailable");
  const candidate = (
    await client.query<{ valid: boolean | null }>(selectionSql, [
      input.propertyId,
      input.connectionId,
      input.externalPropertyId,
      input.bindingGeneration,
      from,
      horizon.through,
      coverage.materializedRevision,
      input.roomTypeId,
    ])
  ).rows[0];
  return candidate
    ? unavailable("room_availability_coverage_unavailable")
    : {
        kind: "current" as const,
        from,
        through: horizon.through,
        roomCount: mappings.rows.length,
        dayCount: nightCount(from, horizon.through),
      };
}

/**
 * Selects and claims one current room/day. Its only provider IO is reading the property's cut-off
 * when the selected night is close enough to be closed by it.
 */
export async function prepareNextChannexRoomAvailabilityDispatch(
  pool: Pool,
  inventory: Inventory,
  input: ChannexPricingJobLeaseInput,
  get: ChannexRead,
  now: () => Date = () => new Date(),
) {
  const lease = { ...input };
  const before = await readScope(pool, lease, false);
  if (before.kind !== "scope") return before;
  if (before.value.fullPropertyReadinessRequired) {
    const readiness = await inventory.getInventoryLaunchReadiness({
      propertyId: before.value.propertyId,
      requiredCoverage: { from: before.value.localToday, through: before.value.through },
    });
    if (!readiness?.ready)
      return { kind: "unavailable" as const, reason: "room_availability_coverage_unavailable" };
  }
  let selected = await readScope(pool, lease, true, before.value);
  if (selected.kind !== "selected") return selected;
  // VAY-2108: nights Channex's cut-off closed are skipped; Channex shows them as 0 until they pass.
  // Sent anyway, they would never read back and would stop every sync of the hotel that day.
  if (
    selected.selection &&
    selected.selection.date <= addDays(selected.scope.localToday, CUT_OFF_REACH_DAYS)
  ) {
    const openFrom = await channexCutOffOpenFrom(
      selected.scope,
      selected.selection.date,
      get,
      now,
      lease,
    );
    if (openFrom) {
      selected = await readScope(pool, lease, true, before.value, openFrom);
      if (selected.kind !== "selected") return selected;
    }
  }
  if (!selected.selection)
    return {
      kind: "room_availability_current" as const,
      from: selected.from,
      through: selected.scope.through,
      roomCount: selected.scope.roomCount,
      dayCount: nightCount(selected.from, selected.scope.through),
    };
  const prepared = await prepareChannexRoomAvailabilityDispatch(
    pool,
    inventory,
    lease,
    selected.selection,
  );
  return prepared.kind === "prepared" ? { ...prepared, ...selected.selection } : prepared;
}

async function readScope(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  select: boolean,
  expected?: Scope,
  openFrom?: string,
) {
  const client = await pool.connect();
  let committed = false,
    discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const authority = await lockChannexPricingPropertyAuthority(client, lease);
    if (
      authority.kind !== "authorized" ||
      (authority.lease.operationType !== "sync_ari" && !authority.lease.publishedOfferProvisioning)
    )
      return unavailable("room_availability_authority_unavailable");
    await lockPmsInventoryMutationScope(client, authority.lease.propertyId);
    const provisionRoomTypeId =
      authority.lease.operationType === "provision"
        ? authority.lease.publishedOfferRoomTypeId
        : null;
    if (
      authority.lease.operationType === "provision" &&
      (!provisionRoomTypeId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          provisionRoomTypeId,
        ))
    )
      return unavailable("room_availability_authority_unavailable");
    const unrestricted = await client.query(
      `SELECT 1 FROM platform.jobs WHERE id=$1::uuid
       AND COALESCE(payload->'restrictionsOnly','false'::jsonb)='false'::jsonb`,
      [lease.jobId],
    );
    if (!unrestricted.rowCount) return unavailable("room_availability_authority_unavailable");
    const mappings = await client.query<{
      mappingId: string;
      roomTypeId: string;
      externalRoomTypeId: string;
      bindingGeneration: string;
    }>(
      `SELECT m.id::text AS "mappingId",m.room_type_id::text AS "roomTypeId",
         m.external_room_type_id AS "externalRoomTypeId",
         c.binding_generation::text AS "bindingGeneration"
       FROM pms.channel_room_type_mappings m
       JOIN pms.channel_connections c
         ON c.id=m.connection_id AND c.property_id=m.property_id
       JOIN pms.room_types r ON r.id=m.room_type_id AND r.property_id=m.property_id
       WHERE m.property_id=$1 AND m.connection_id=$2 AND m.status='active' AND r.active
         AND c.connection_status='connected' AND c.external_property_id=$3
         AND c.external_property_id<>'' AND c.external_property_id=btrim(c.external_property_id)
         AND m.external_room_type_id<>''
         AND m.external_room_type_id=btrim(m.external_room_type_id)
         AND ($4::uuid IS NULL OR m.room_type_id=$4::uuid)
         AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closed
           WHERE closed.property_id=r.property_id AND closed.room_type_id=r.id)
       ORDER BY m.room_type_id::text COLLATE "C",m.id
       FOR SHARE OF m,c,r NOWAIT`,
      [
        authority.lease.propertyId,
        authority.connectionId,
        authority.externalPropertyId,
        provisionRoomTypeId,
      ],
    );
    if (!mappings.rows.length) return unavailable("room_availability_mapping_unavailable");
    const coverage = (
      await client.query<{
        from: string;
        through: string;
        materializedRevision: number;
        timeZone: string;
      }>(
        `SELECT coverage.coverage_from::text AS "from",
           coverage.coverage_through::text AS "through",
           coverage.materialized_revision AS "materializedRevision",
           calendar.property_time_zone AS "timeZone"
         FROM pms.inventory_materialization_coverage coverage
         JOIN pms.operating_calendar_revisions calendar
           ON calendar.property_id=coverage.property_id
          AND calendar.calendar_revision=coverage.calendar_revision
         WHERE coverage.property_id=$1
           AND coverage.calendar_revision=coverage.materialized_revision
           AND coverage.materialized_day_count=coverage.expected_day_count
           AND ($2::uuid IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM pms.operating_calendar_revisions newer
             WHERE newer.property_id=calendar.property_id
               AND newer.calendar_revision>calendar.calendar_revision))
         FOR SHARE OF coverage,calendar NOWAIT`,
        [authority.lease.propertyId, provisionRoomTypeId],
      )
    ).rows[0];
    if (
      coverage &&
      provisionRoomTypeId &&
      !(await lockSelectedRoomMaterializationCurrent(
        client,
        authority.lease.propertyId,
        provisionRoomTypeId,
        coverage.materializedRevision,
      ))
    )
      return unavailable("room_availability_coverage_unavailable");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
    const localToday = coverage && now ? channexPropertyLocalDate(coverage.timeZone, now) : null;
    if (!coverage || !localToday || coverage.from > localToday || coverage.through < localToday)
      return unavailable("room_availability_coverage_unavailable");
    const horizon = availabilityWindow(localToday, coverage.through);
    const bindingGenerations = new Set(mappings.rows.map((row) => row.bindingGeneration));
    if (!horizon || bindingGenerations.size !== 1)
      return unavailable("room_availability_coverage_unavailable");
    const scope: Scope = {
      propertyId: authority.lease.propertyId,
      connectionId: authority.connectionId,
      externalPropertyId: authority.externalPropertyId,
      externalRoomTypeIds: mappings.rows.map((row) => row.externalRoomTypeId),
      bindingGeneration: mappings.rows[0]!.bindingGeneration,
      localToday,
      through: horizon.through,
      roomCount: mappings.rows.length,
      dayCount: horizon.dayCount,
      fullPropertyReadinessRequired: authority.lease.operationType !== "provision",
    };
    if (expected && !isDeepStrictEqual(expected, scope))
      return unavailable("room_availability_coverage_unavailable");
    const from = windowStart(localToday, openFrom);
    if (!from) return unavailable("room_availability_coverage_unavailable");
    if (!select) {
      await client.query("COMMIT");
      committed = true;
      return { kind: "scope" as const, value: scope };
    }
    const candidate = (
      await client.query<{
        roomTypeId: string;
        date: string;
        valid: boolean | null;
      }>(selectionSql, [
        scope.propertyId,
        scope.connectionId,
        scope.externalPropertyId,
        scope.bindingGeneration,
        from,
        scope.through,
        coverage.materializedRevision,
        provisionRoomTypeId,
      ])
    ).rows[0];
    const finalAuthority = await lockChannexPricingPropertyAuthority(client, lease);
    if (!isDeepStrictEqual(authority, finalAuthority))
      return unavailable("room_availability_authority_unavailable");
    await client.query("COMMIT");
    committed = true;
    if (candidate && candidate.valid !== true)
      return { kind: "unavailable" as const, reason: "room_availability_coverage_unavailable" };
    return {
      kind: "selected" as const,
      scope,
      from,
      selection: candidate ? { roomTypeId: candidate.roomTypeId, date: candidate.date } : null,
    };
  } finally {
    if (!committed)
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    client.release(discard);
  }
}

function unavailable(reason: string) {
  return { kind: "unavailable" as const, reason };
}

/**
 * VAY-2108: availability covers the hotel's today and the next 365 nights, the PMS inventory
 * horizon (launch readiness checks no more). Auto-open can keep the calendar open further (Tiga:
 * 379 nights); those later nights stay as they are in Channex instead of stopping every full sync.
 */
function availabilityWindow(localToday: string, coverageThrough: string) {
  const start = Date.parse(`${localToday}T00:00:00.000Z`),
    end = Date.parse(`${coverageThrough}T00:00:00.000Z`);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  const last = Math.min(end, start + (PMS_INVENTORY_HORIZON_MAX_DAYS - 1) * 86_400_000);
  return {
    through: new Date(last).toISOString().slice(0, 10),
    dayCount: (last - start) / 86_400_000 + 1,
  };
}

/** The window's first night: the hotel's today, or the given later night a cut-off left open. */
function windowStart(localToday: string, openFrom: string | undefined) {
  if (openFrom === undefined) return localToday;
  const parsed = Date.parse(`${openFrom}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(openFrom) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== openFrom ||
    openFrom > addDays(localToday, CUT_OFF_REACH_DAYS + 1)
  )
    return null;
  return openFrom > localToday ? openFrom : localToday;
}

function nightCount(from: string, through: string) {
  const days =
    (Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
  return Math.max(0, days + 1);
}

async function lockSelectedRoomMaterializationCurrent(
  client: Pick<PoolClient, "query">,
  propertyId: string,
  roomTypeId: string,
  materializedRevision: number,
) {
  const row = (
    await client.query<{ valid: boolean }>(
      `WITH latest AS (
         SELECT max(calendar_revision) AS calendar_revision
         FROM pms.operating_calendar_revisions WHERE property_id=$1
       )
       SELECT materialized_calendar.contract_version=current_calendar.contract_version
          AND materialized_calendar.property_time_zone=current_calendar.property_time_zone
          AND materialized_calendar.schedule_mode=current_calendar.schedule_mode
          AND materialized_calendar.recurring_period_count=current_calendar.recurring_period_count
          AND materialized_calendar.default_minimum_stay_nights=current_calendar.default_minimum_stay_nights
          AND materialized_binding.source_room_units_revision=current_binding.source_room_units_revision
          AND materialized_binding.physical_capacity_count=current_binding.physical_capacity_count
          AND materialized_binding.starting_sellable_limit_count=current_binding.starting_sellable_limit_count
          AND COALESCE((SELECT jsonb_agg(jsonb_build_array(period_index,start_month,start_day,end_month,end_day)
                         ORDER BY period_index)
             FROM pms.operating_calendar_recurring_periods
             WHERE property_id=$1 AND calendar_revision=materialized_calendar.calendar_revision),'[]'::jsonb)
              = COALESCE((SELECT jsonb_agg(jsonb_build_array(period_index,start_month,start_day,end_month,end_day)
                            ORDER BY period_index)
                FROM pms.operating_calendar_recurring_periods
                WHERE property_id=$1 AND calendar_revision=current_calendar.calendar_revision),'[]'::jsonb)
          AS valid
       FROM latest
       JOIN pms.operating_calendar_revisions materialized_calendar
         ON materialized_calendar.property_id=$1 AND materialized_calendar.calendar_revision=$3
       JOIN pms.operating_calendar_revisions current_calendar
         ON current_calendar.property_id=$1 AND current_calendar.calendar_revision=latest.calendar_revision
       JOIN pms.operating_calendar_room_bindings materialized_binding
         ON materialized_binding.property_id=$1
        AND materialized_binding.calendar_revision=materialized_calendar.calendar_revision
        AND materialized_binding.room_type_id=$2
       JOIN pms.operating_calendar_room_bindings current_binding
         ON current_binding.property_id=$1
        AND current_binding.calendar_revision=current_calendar.calendar_revision
        AND current_binding.room_type_id=$2
      `,
      [propertyId, roomTypeId, materializedRevision],
    )
  ).rows[0];
  return row?.valid === true;
}

const selectionSql = `
WITH mapped AS (
  SELECT m.id,m.room_type_id AS mapped_room_type_id,m.external_room_type_id,
    binding.source_room_facts_revision,binding.source_room_units_revision,
    binding.physical_capacity_count,calendar.property_profile_revision,
    calendar.property_time_zone
  FROM pms.channel_room_type_mappings m
  JOIN pms.room_types room ON room.id=m.room_type_id AND room.property_id=m.property_id
  LEFT JOIN pms.operating_calendar_room_bindings binding
    ON binding.property_id=m.property_id AND binding.room_type_id=m.room_type_id
   AND binding.calendar_revision=$7
  LEFT JOIN pms.operating_calendar_revisions calendar
    ON calendar.property_id=binding.property_id
   AND calendar.calendar_revision=binding.calendar_revision
  WHERE m.property_id=$1 AND m.connection_id=$2 AND m.status='active' AND room.active
    AND ($8::uuid IS NULL OR m.room_type_id=$8::uuid)
    AND m.external_room_type_id<>'' AND m.external_room_type_id=btrim(m.external_room_type_id)
    AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closed
      WHERE closed.property_id=room.property_id AND closed.room_type_id=room.id)
), candidates AS (
  SELECT mapped.*,days.day::date AS service_date,inventory.*,
    inventory.property_id IS NOT NULL
      AND inventory.calendar_revision=$7
      AND inventory.inventory_revision BETWEEN 1 AND 2147483647
      AND inventory.generated_source_revision=inventory.calendar_revision
      AND inventory.channel_source_revision BETWEEN 0 AND 2147483647
      AND inventory.manual_source_revision BETWEEN 0 AND 2147483647
      AND inventory.block_source_revision BETWEEN 0 AND 2147483647
      AND inventory.booking_source_revision BETWEEN 0 AND 2147483647
      AND inventory.linked_source_revision BETWEEN 0 AND 2147483647
      AND inventory.total_count=mapped.physical_capacity_count
      AND inventory.generated_sellable_limit_count BETWEEN 0 AND inventory.total_count
      AND (inventory.channel_sellable_limit_count IS NULL OR
        inventory.channel_sellable_limit_count BETWEEN 0 AND inventory.total_count)
      AND (inventory.manual_sellable_limit_count IS NULL OR
        inventory.manual_sellable_limit_count BETWEEN 0 AND inventory.total_count)
      AND inventory.assigned_count+inventory.blocked_count<=inventory.total_count
      AND inventory.effective_sellable_limit_count=
        COALESCE(inventory.manual_sellable_limit_count,
          inventory.channel_sellable_limit_count,inventory.generated_sellable_limit_count)
      AND inventory.available_count=CASE
        WHEN inventory.status='closed' OR inventory.linked_stop_sell THEN 0
        ELSE GREATEST(0,inventory.effective_sellable_limit_count-
          inventory.assigned_count-inventory.blocked_count) END AS valid
  FROM mapped CROSS JOIN generate_series($5::date,$6::date,interval '1 day') days(day)
  LEFT JOIN pms.inventory_days inventory
    ON inventory.property_id=$1 AND inventory.room_type_id=mapped.mapped_room_type_id
   AND inventory.stay_date=days.day::date
), evidence AS (
  SELECT candidates.*,
    jsonb_build_object(
      'kind','available','day',jsonb_build_object(
        'propertyId',$1::uuid::text,'roomTypeId',mapped_room_type_id::text,
        'stayDate',service_date::text,'calendarRevision',calendar_revision,
        'inventoryRevision',inventory_revision,'sourceRevisions',jsonb_build_object(
          'generated',generated_source_revision,'channel',channel_source_revision,
          'manual',manual_source_revision,'block',block_source_revision,
          'booking',booking_source_revision),
        'operatingStatus',status,'physicalCapacityCount',total_count,
        'generatedSellableLimitCount',generated_sellable_limit_count,
        'channelSellableLimitCount',channel_sellable_limit_count,
        'manualSellableLimitCount',manual_sellable_limit_count,
        'effectiveSellableLimitCount',effective_sellable_limit_count,
        'assignedCount',assigned_count,'blockedCount',blocked_count,
        'linkedStopSell',linked_stop_sell,'linkedSourceRevision',linked_source_revision,
        'availableCount',available_count),
      'configurationSource',jsonb_build_object('ownerDomain','pms',
        'entityType','pms_operating_calendar.v1','entityId',$1::uuid::text,
        'revision','calendar:'||$7::text),
      'propertyProfileSource',jsonb_build_object('ownerDomain','hotel_catalog',
        'entityType','property_profile','entityId',$1::uuid::text,
        'revision','profile:'||property_profile_revision::text),
      'propertyTimeZone',property_time_zone,'materializedRevision',$7,
      'sourceRoomFactsRevision',source_room_facts_revision,
      'sourceRoomUnitsRevision',source_room_units_revision) AS current_evidence,
    jsonb_build_object('values',jsonb_build_array(jsonb_build_object(
      'property_id',$3::text,'room_type_id',external_room_type_id,
      'date_from',service_date::text,'date_to',service_date::text,
      'availability',available_count))) AS current_request
  FROM candidates
), uncovered AS (
  SELECT evidence.* FROM evidence
  WHERE valid IS DISTINCT FROM TRUE OR NOT EXISTS (
    SELECT 1 FROM pms.channex_room_availability_attempts attempt
    JOIN pms.channex_room_availability_receipts receipt ON receipt.attempt_id=attempt.id
    JOIN pms.channex_room_availability_reconciliation_attestations attestation
      ON attestation.attempt_id=attempt.id AND attestation.receipt_id=receipt.id
    WHERE attempt.state='reconciled' AND attempt.property_id=$1
      AND attempt.connection_id=$2 AND attempt.mapping_id=evidence.id
      AND attempt.binding_generation=$4 AND attempt.room_type_id=evidence.mapped_room_type_id
      AND attempt.external_property_id=$3
      AND attempt.external_room_type_id=evidence.external_room_type_id
      AND attempt.service_date=evidence.service_date
      AND attempt.available_count=evidence.available_count
      AND attempt.inventory_evidence=evidence.current_evidence
      AND attempt.request_body=evidence.current_request
      AND attempt.reconciliation_evidence->>'schemaVersion'='1'
      AND attempt.reconciliation_evidence->>'completionBasis'='finished_task_fifo'
      AND attempt.reconciliation_evidence->>'observationsSha256' ~ '^[a-f0-9]{64}$'
      AND attempt.reconciliation_evidence->>'inventoryEvidenceSha256' ~ '^[a-f0-9]{64}$'
      AND attempt.inventory_evidence_sha256 IS NOT NULL
      AND attempt.inventory_evidence_sha256=
        attempt.reconciliation_evidence->>'inventoryEvidenceSha256'
      AND attestation.inventory_evidence_sha256=attempt.inventory_evidence_sha256
      AND attestation.observations_sha256=
        attempt.reconciliation_evidence->>'observationsSha256'
      AND attestation.reconciliation_evidence=attempt.reconciliation_evidence
      AND receipt.id::text=attempt.reconciliation_evidence->>'originalReceiptId'
      AND receipt.outcome='complete_json' AND receipt.http_status=200
      AND NOT receipt.has_warnings AND receipt.warning_reason IS NULL
      AND cardinality(receipt.task_ids) BETWEEN 1 AND 100
      AND cardinality(receipt.task_ids)=(SELECT count(DISTINCT task) FROM unnest(receipt.task_ids) task)
      AND attempt.reconciliation_evidence->'taskCount'=to_jsonb(cardinality(receipt.task_ids))
      AND attempt.reconciliation_evidence->'availability'=jsonb_build_object(
        'kind','availability_observed','externalPropertyId',$3::text,
        'externalRoomTypeId',evidence.external_room_type_id,
        'date',evidence.service_date::text,'availableCount',evidence.available_count)
      AND (SELECT count(*) FROM pms.channex_room_availability_receipts other
        WHERE other.attempt_id=attempt.id)=1)
)
SELECT mapped_room_type_id::text AS "roomTypeId",service_date::text AS date,valid
FROM uncovered ORDER BY mapped_room_type_id::text COLLATE "C",service_date LIMIT 1`;
