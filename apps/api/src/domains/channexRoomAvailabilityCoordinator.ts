import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";
import { prepareChannexRoomAvailabilityDispatch } from "./channexRoomAvailabilityDispatch.js";

type Inventory = Pick<
  PmsInventoryMaterializationRepository,
  "getCurrentInventoryDay" | "getInventoryLaunchReadiness"
>;

type Scope = Readonly<{
  propertyId: string;
  connectionId: string;
  externalPropertyId: string;
  bindingGeneration: string;
  localToday: string;
  through: string;
  roomCount: number;
  dayCount: number;
  fullPropertyReadinessRequired: boolean;
}>;

/** Rechecks complete room availability evidence inside a caller-owned activation transaction. */
export async function lockCurrentChannexRoomAvailability(
  client: Pick<PoolClient, "query">,
  input: Readonly<{
    propertyId: string;
    connectionId: string;
    externalPropertyId: string;
    bindingGeneration: string;
    roomTypeId: string;
  }>,
) {
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
         AND NOT EXISTS (SELECT 1 FROM pms.operating_calendar_revisions newer
           WHERE newer.property_id=calendar.property_id
             AND newer.calendar_revision>calendar.calendar_revision)
       FOR SHARE OF coverage,calendar NOWAIT`,
      [input.propertyId],
    )
  ).rows[0];
  const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
  const localToday = coverage && now ? channexPropertyLocalDate(coverage.timeZone, now) : null;
  if (!coverage || !localToday || !inclusiveDayCount(localToday, coverage.through))
    return unavailable("room_availability_coverage_unavailable");
  const candidate = (
    await client.query<{ valid: boolean | null }>(selectionSql, [
      input.propertyId,
      input.connectionId,
      input.externalPropertyId,
      input.bindingGeneration,
      localToday,
      coverage.through,
      coverage.materializedRevision,
      input.roomTypeId,
    ])
  ).rows[0];
  return candidate
    ? unavailable("room_availability_coverage_unavailable")
    : {
        kind: "current" as const,
        from: localToday,
        through: coverage.through,
        roomCount: mappings.rows.length,
        dayCount: inclusiveDayCount(localToday, coverage.through)!,
      };
}

/** Selects and claims one current room/day. It performs no provider IO itself. */
export async function prepareNextChannexRoomAvailabilityDispatch(
  pool: Pool,
  inventory: Inventory,
  input: ChannexPricingJobLeaseInput,
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
  const selected = await readScope(pool, lease, true, before.value);
  if (selected.kind !== "selected") return selected;
  if (!selected.selection)
    return {
      kind: "room_availability_current" as const,
      from: selected.scope.localToday,
      through: selected.scope.through,
      roomCount: selected.scope.roomCount,
      dayCount: selected.scope.dayCount,
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
           AND NOT EXISTS (SELECT 1 FROM pms.operating_calendar_revisions newer
             WHERE newer.property_id=calendar.property_id
               AND newer.calendar_revision>calendar.calendar_revision)
         FOR SHARE OF coverage,calendar NOWAIT`,
        [authority.lease.propertyId],
      )
    ).rows[0];
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
    const localToday = coverage && now ? channexPropertyLocalDate(coverage.timeZone, now) : null;
    if (!coverage || !localToday || coverage.from > localToday || coverage.through < localToday)
      return unavailable("room_availability_coverage_unavailable");
    const dayCount = inclusiveDayCount(localToday, coverage.through);
    const bindingGenerations = new Set(mappings.rows.map((row) => row.bindingGeneration));
    if (!dayCount || bindingGenerations.size !== 1)
      return unavailable("room_availability_coverage_unavailable");
    const scope: Scope = {
      propertyId: authority.lease.propertyId,
      connectionId: authority.connectionId,
      externalPropertyId: authority.externalPropertyId,
      bindingGeneration: mappings.rows[0]!.bindingGeneration,
      localToday,
      through: coverage.through,
      roomCount: mappings.rows.length,
      dayCount,
      fullPropertyReadinessRequired: authority.lease.operationType !== "provision",
    };
    if (expected && !isDeepStrictEqual(expected, scope))
      return unavailable("room_availability_coverage_unavailable");
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
        scope.localToday,
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

function inclusiveDayCount(from: string, through: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`),
    end = Date.parse(`${through}T00:00:00.000Z`),
    count = (end - start) / 86_400_000 + 1;
  return Number.isSafeInteger(count) && count >= 1 && count <= 366 ? count : null;
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
