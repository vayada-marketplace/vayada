import { createHash } from "node:crypto";
import pg from "pg";
import type { ApiConfig } from "../config.js";
import { adoptChannexStagingCatalog } from "./channexStagingCatalogAdoption.js";
import { retainedRevisionScope as scope } from "./channexStagingCatalogEvidence.js";
import { resolveStagingCatalogReference } from "./channexStagingCatalogReference.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { persistPmsInventoryMaterializationDays } from "./pmsInventoryMaterializationRepository.js";
import { loadPmsOperatingCalendarConfigurationByRevision } from "./pmsOperatingCalendarReadModel.js";
import { pmsRoomFactsSnapshotFromRow } from "./pmsRoomFactsReadModel.js";

export const stagingDay = {
  roomTypeId: "487d717d-6e61-4696-9ea9-3338f069ca06",
  stayDate: "2026-09-14",
} as const;
export const noShowStagingDay = { ...stagingDay, stayDate: "2026-09-20" } as const;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireState(condition: unknown): asserts condition {
  if (!condition) throw new Error("staging_day_conflict");
}

/** Explicit one-date exception; never changes recurring configuration or coverage. */
export async function prepareChannexStagingDay(
  config: ApiConfig,
  input: {
    catalogHash: string;
    approvalRef: string;
    applyHash?: string;
    noShow?: boolean;
    catalogApprovalRef?: string;
  },
  request: typeof fetch = fetch,
) {
  requireState(input.noShow === undefined || typeof input.noShow === "boolean");
  const day = input.noShow ? noShowStagingDay : stagingDay;
  const auditKey = `pms.staging-day:${scope.propertyId}:${day.roomTypeId}:${day.stayDate}:v1`;
  const approvalPattern = input.noShow
    ? /^VAY-1535:[a-zA-Z0-9:_-]{1,120}$/
    : /^VAY-2013:[a-zA-Z0-9:_-]{1,120}$/;
  requireState(approvalPattern.test(input.approvalRef));
  requireState(
    input.noShow
      ? typeof input.catalogApprovalRef === "string" &&
          /^VAY-2013:[a-zA-Z0-9:_-]{1,120}$/.test(input.catalogApprovalRef)
      : input.catalogApprovalRef === undefined,
  );
  const catalogApprovalRef = input.noShow ? input.catalogApprovalRef! : input.approvalRef;
  requireState(/^[a-f0-9]{64}$/.test(input.catalogHash));
  requireState(input.applyHash === undefined || /^[a-f0-9]{64}$/.test(input.applyHash));
  // New capacity uses the accepted immutable reference below; historical OTA
  // catalog pricing can change independently of this room's current readiness.
  if (input.noShow) {
    requireState(
      config.apiRuntime === "next" &&
        !config.backgroundWorkersEnabled &&
        config.channexManagement.apiBaseUrl === "https://staging.channex.io" &&
        config.channexManagement.capabilityModes.bookingSync === "observe_only" &&
        config.channexManagement.stagingRestrictionsPropertyId === scope.propertyId &&
        !!config.channexManagement.apiKey &&
        !!config.targetDatabaseUrl,
    );
  } else {
    const catalog = await adoptChannexStagingCatalog(
      config,
      {
        providerPropertyId: scope.providerPropertyId,
        bookingId: scope.bookingId,
        revisionId: scope.revisionId,
        approvalRef: catalogApprovalRef,
        retainedRevision: true,
        preImport: true,
      },
      request,
    );
    requireState(
      catalog.outcome === "replayed" &&
        catalog.hash === input.catalogHash &&
        catalog.roomTypeId === day.roomTypeId,
    );
  }
  const providerGuard: Record<string, unknown> = {};
  const query = new URLSearchParams({
    "filter[property_id]": scope.providerPropertyId,
    "filter[date][gte]": day.stayDate,
    "filter[date][lte]": day.stayDate,
    "filter[restrictions]": "stop_sell",
  });
  for (const kind of ["availability", "restrictions"] as const) {
    const response = await request(`https://staging.channex.io/api/v1/${kind}?${query}`, {
      headers: { "user-api-key": config.channexManagement.apiKey! },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    requireState(response.ok);
    const data = (await response.json()) as { data?: Record<string, Record<string, unknown>> };
    providerGuard[kind] =
      data.data?.[kind === "availability" ? scope.roomId : scope.rateId]?.[day.stayDate];
  }
  requireState(
    typeof providerGuard.availability === "number" &&
      Number.isInteger(providerGuard.availability) &&
      providerGuard.availability <= 0,
  );
  requireState(
    (providerGuard.restrictions as { stop_sell?: unknown } | undefined)?.stop_sell === true,
  );
  const pool = new pg.Pool({
    connectionString: config.targetDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const values = [scope.propertyId, day.roomTypeId, day.stayDate];
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    await lockPmsInventoryMutationScope(client, scope.propertyId);
    const bindings = (
      await client.query<{ id: string; generation: string }>(
        `SELECT c.id::text,c.binding_generation::text generation FROM pms.channel_connections c
       JOIN pms.channel_binding_claims claim ON claim.property_id=c.property_id AND claim.provider=c.provider
         AND claim.external_property_id=c.external_property_id
       WHERE c.property_id=$1::uuid AND c.external_property_id=$2 AND c.provider='channex'
         AND c.connection_status='connected' AND claim.claim_state='active' FOR UPDATE OF c,claim`,
        [scope.propertyId, scope.providerPropertyId],
      )
    ).rows;
    requireState(bindings.length === 1);
    const binding = bindings[0]!;
    const reference = await resolveStagingCatalogReference(client, {
      propertyId: scope.propertyId,
      connectionId: binding.id,
      bindingGeneration: binding.generation,
      bookingId: null,
      bootstrapHash: input.catalogHash,
      providerBookingId: scope.bookingId,
      revisionId: scope.revisionId,
      externalRoomTypeId: scope.roomId,
      externalRatePlanId: scope.rateId,
    });
    requireState(reference.length === 1 && reference[0]!.roomTypeId === day.roomTypeId);
    const room = (
      await client.query(
        `SELECT id::text AS "roomTypeId",property_id::text AS "propertyId",name,description,category,active,
        occupancy_limits AS "occupancyLimits",room_attributes AS "roomAttributes",
        room_facts_revision AS "roomFactsRevision",room_units_revision::int AS "unitsRevision",
        created_at AS "createdAt",updated_at AS "updatedAt",linked_inventory_group_id
       FROM pms.room_types WHERE property_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
        values.slice(0, 2),
      )
    ).rows[0];
    requireState(room && room.active && room.linked_inventory_group_id === null);
    const facts = pmsRoomFactsSnapshotFromRow(room);
    requireState(facts.roomFactsRevision === 2 && room.unitsRevision === 2);
    requireState(
      facts.facts.bathroomType === "private" &&
        hash(facts.facts.beds) === hash([{ type: "double", quantity: 1 }]) &&
        hash(facts.facts.occupancy) === hash({ maxGuests: 2, maxAdults: 2, maxChildren: 0 }),
    );
    const units = (
      await client.query(
        `SELECT id::text,status FROM pms.rooms WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND status<>'retired' ORDER BY id FOR UPDATE`,
        values.slice(0, 2),
      )
    ).rows;
    requireState(units.length === 1 && units[0]!.status === "available");
    const blocked = await client.query(
      `SELECT 1 FROM pms.room_blocks WHERE property_id=$1::uuid AND room_type_id=$2::uuid
         AND status='active' AND starts_on<=$3::date AND ends_on>=$3::date
       UNION ALL SELECT 1 FROM distribution.public_room_offer_snapshots WHERE property_id=$1::uuid AND room_type_id=$2::uuid
       UNION ALL SELECT 1 FROM pms.room_type_media WHERE property_id=$1::uuid AND room_type_id=$2::uuid
       UNION ALL SELECT 1 FROM distribution.public_booking_content_revisions r
       WHERE r.property_id=$1::uuid AND (
         EXISTS(SELECT 1 FROM distribution.active_public_booking_revision a WHERE a.property_id=r.property_id AND a.content_revision_id=r.id)
         OR EXISTS(SELECT 1 FROM booking.booking_publication_attempts p WHERE p.property_id=r.property_id AND p.result_content_revision_id=r.id AND p.status='succeeded'))
       AND (jsonb_path_exists(r.source_manifest,'strict $.** ? (@ == $room)',jsonb_build_object('room',to_jsonb($2::uuid::text)))
         OR jsonb_path_exists(r.public_content,'strict $.** ? (@ == $room)',jsonb_build_object('room',to_jsonb($2::uuid::text))))
       UNION ALL SELECT 1 FROM booking.booking_publication_attempts p WHERE p.property_id=$1::uuid
         AND p.status IN ('pending','unknown') AND jsonb_path_exists(p.source_manifest,
           'strict $.** ? (@ == $room)',jsonb_build_object('room',to_jsonb($2::uuid::text)))`,
      values,
    );
    requireState(!blocked.rowCount);
    const revision = Number(
      (
        await client.query(
          `SELECT max(calendar_revision) revision FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid`,
          [scope.propertyId],
        )
      ).rows[0]?.revision,
    );
    requireState(revision === 9);
    const calendar = await loadPmsOperatingCalendarConfigurationByRevision(
      client,
      scope.propertyId,
      revision,
      {
        ownerDomain: "hotel_catalog",
        registryVersion: "staging-base-calendar.v1",
        isCanonicalIanaTimeZone: (zone) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        },
      },
    );
    requireState(
      calendar &&
        calendar.sourceInputs.roomBindings.some(
          (r) =>
            r.roomTypeId === day.roomTypeId &&
            r.sourceRoomFactsRevision === 2 &&
            r.sourceRoomUnitsRevision === 2 &&
            r.physicalCapacityCount === 1 &&
            r.startingSellableLimitCount === 1,
        ),
    );
    if (input.noShow) {
      requireState(
        calendar.schedule.mode === "recurring" &&
          hash(calendar.schedule.periods) === hash([{ startsOn: "09-20", endsOn: "09-21" }]),
      );
    }
    const evidence = {
      version: "pms-staging-date-exception.v1",
      ...scope,
      ...day,
      catalogHash: input.catalogHash,
      providerGuard,
      binding,
      baseCalendar: calendar,
      facts,
      unitsRevision: room.unitsRevision,
      units,
      approvalRef: input.approvalRef,
      originalState: "absent",
      capacity: 1,
      ...(input.noShow ? { purpose: "no-show", catalogApprovalRef } : {}),
    };
    const previewHash = hash(evidence);
    const existing = (
      await client.query(
        `SELECT redacted_payload FROM platform.product_audit_events WHERE audit_key=$1`,
        [auditKey],
      )
    ).rows[0]?.redacted_payload;
    const inventory = async () =>
      (
        await client.query(
          `SELECT to_jsonb(i) state,md5((to_jsonb(i)-ARRAY['assigned_count','available_count','booking_source_revision','inventory_revision','updated_at'])::text) signature
       FROM pms.inventory_days i WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date=$3::date FOR UPDATE`,
          values,
        )
      ).rows[0];
    const current = await inventory();
    if (existing) {
      requireState(
        existing.hash === previewHash && existing.inventorySignature === current?.signature,
      );
      requireState(input.applyHash === undefined || input.applyHash === existing.hash);
      const count = current.state.assigned_count;
      requireState((count === 0 || count === 1) && current.state.available_count === 1 - count);
      const assignments = (
        await client.query(
          `SELECT b.source_booking_id,b.booking_channel,m.external_revision_id,m.external_booking_id,m.connection_id::text,a.check_in::text,a.check_out::text FROM pms.operational_booking_assignments a
         JOIN booking.guest_bookings b ON b.property_id=a.property_id AND b.id=a.guest_booking_id
         LEFT JOIN pms.channel_booking_mappings m ON m.property_id=b.property_id AND m.guest_booking_id=b.id
         WHERE a.property_id=$1::uuid AND a.room_type_id=$2::uuid AND a.check_in<=$3::date AND a.check_out>$3::date`,
          values,
        )
      ).rows;
      requireState(
        assignments.length === count &&
          assignments.every((a) =>
            input.noShow
              ? a.connection_id === binding.id &&
                a.booking_channel === "booking_com" &&
                /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.external_booking_id ?? "") &&
                /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
                  a.external_revision_id ?? "",
                ) &&
                a.source_booking_id === `channex:${scope.propertyId}:${a.external_booking_id}` &&
                a.check_in === day.stayDate &&
                a.check_out === "2026-09-21"
              : a.source_booking_id === `channex:${scope.propertyId}:${scope.bookingId}` &&
                a.external_revision_id === scope.revisionId,
          ),
      );
      await client.query("ROLLBACK");
      return { outcome: "replayed", hash: previewHash, ...day };
    }
    requireState(!current);
    requireState(
      !(
        await client.query(
          `SELECT 1 FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND room_type_id=$2::uuid
           AND (NOT $4::boolean OR (check_in<=$3::date AND check_out>$3::date))`,
          [...values, input.noShow === true],
        )
      ).rowCount,
    );
    if (input.applyHash === undefined) {
      await client.query("ROLLBACK");
      return {
        outcome: "preview",
        hash: previewHash,
        ...day,
        baseCalendarRevision: revision,
      };
    }
    requireState(input.applyHash === previewHash);
    await persistPmsInventoryMaterializationDays(
      client,
      [
        {
          propertyId: scope.propertyId,
          ...day,
          calendarRevision: revision,
          inventoryRevision: 1,
          sourceRevisions: { generated: revision, channel: 0, manual: 0, block: 0, booking: 0 },
          operatingStatus: "open",
          physicalCapacityCount: 1,
          generatedSellableLimitCount: 1,
          channelSellableLimitCount: null,
          manualSellableLimitCount: null,
          effectiveSellableLimitCount: 1,
          assignedCount: 0,
          blockedCount: 0,
          linkedStopSell: false,
          linkedSourceRevision: 0,
          availableCount: 1,
        },
      ],
      new Date(),
    );
    const created = await inventory();
    requireState(created);
    await client.query(
      `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
       target_resource_product,target_resource_type,target_resource_id,redacted_payload,retention_class,privacy_scope)
       VALUES($1,'pms','pms.staging_date_exception.applied',now(),'property',$2::uuid,'system','pms','room_type',$3,$4::jsonb,'provider_receipt','restricted')`,
      [
        auditKey,
        scope.propertyId,
        day.roomTypeId,
        { hash: previewHash, evidence, inventorySignature: created.signature },
      ],
    );
    await client.query("COMMIT");
    return { outcome: "applied", hash: previewHash, ...day, baseCalendarRevision: revision };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
