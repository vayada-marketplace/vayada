import { createHash } from "node:crypto";

import { getTimezone } from "countries-and-timezones";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_IDEMPOTENCY,
  PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
  PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarConfigurationSnapshot,
} from "@vayada/domain-pms";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { deterministicUuid, integer, optionalUuid, uuid } from "./productionBookingValues.js";
import { carriedCohortHotel } from "./productionPmsCohortSetup.js";
import { addPmsBlocker } from "./productionPmsContext.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { pmsRecord } from "./productionPmsValues.js";

// VAY-1362 setup completeness: the operating calendar native hotel setup saves
// (pmsOperatingCalendarCommandRepository): revision 1, year-round, one binding per operating room
// type at its physical capacity, with the idempotency key, domain event and outbox row its foreign
// keys require, and its audit row. The migration is the actor of the event and the audit.

/** Native time zone registry (hotelCatalogOperatingCalendarPropertyProfileEvidence.ts). */
const TIME_ZONE_REGISTRY = Object.freeze({
  ownerDomain: "hotel_catalog" as const,
  registryVersion: "countries-and-timezones@3.9.0",
  isCanonicalIanaTimeZone(value: string): boolean {
    try {
      const zone = getTimezone(value);
      return zone !== null && zone.name === value && zone.aliasOf === null;
    } catch {
      return false;
    }
  },
});

export type PlannedCohortCalendar = {
  configuration: PmsOperatingCalendarConfigurationSnapshot;
  organizationId: string;
  hotel: IdentitySourceRow;
};

/** Calendars for carried cohort hotels whose rooms can be bound as native setup binds them. A
 * hotel that cannot (no operating room type, a room type without rooms or whose inventory total
 * differs from its rooms, no owner organization, owner or canonical time zone) gets none and
 * stays in setup. */
export function planPmsCohortCalendars(
  context: PmsBuildContext,
  roomRecords: PmsTargetRecord[],
): PlannedCohortCalendar[] {
  if (!context.cohort) return [];
  const properties = new Map(
    (context.target.cohortProperties ?? []).map((row) => [row.propertyId, row]),
  );
  const existingRoomTypes = new Map(
    context.target.records
      .filter((record) => record.targetTable === "room_types")
      .map((record) => [record.targetId, record.row]),
  );
  const at = new Date(context.completedAt).toISOString();
  const calendars: PlannedCohortCalendar[] = [];
  for (const hotel of context.rowsByTable.get("hotels") ?? []) {
    const hotelId = String(hotel.data["id"] ?? "").toLowerCase();
    const propertyId = context.propertyByHotel.get(hotelId);
    if (!propertyId || !carriedCohortHotel(context, hotelId)) continue;
    const property = properties.get(propertyId);
    const roomTypes = roomRecords.filter(
      (record) =>
        record.targetTable === "room_types" &&
        record.row["propertyId"] === propertyId &&
        record.row["active"] === true,
    );
    const bindings = roomTypes
      .map((roomType) => {
        const source = context.roomTypeById.get(roomType.targetId);
        const capacity = roomRecords.filter(
          (record) =>
            record.targetTable === "rooms" &&
            record.row["roomTypeId"] === roomType.targetId &&
            record.row["status"] !== "retired",
        ).length;
        const current = existingRoomTypes.get(roomType.targetId);
        return {
          roomTypeId: roomType.targetId,
          sourceRoomFactsRevision: Number(current?.["roomFactsRevision"] ?? 1),
          sourceRoomUnitsRevision: Number(current?.["roomUnitsRevision"] ?? 1),
          physicalCapacityCount: capacity,
          startingSellableLimitCount: capacity,
          inventoryTotal: integer(source?.data["total_rooms"], "total_rooms", 0),
        };
      })
      .sort((left, right) => (left.roomTypeId < right.roomTypeId ? -1 : 1));
    const creator = optionalUuid(hotel.data["user_id"], "user_id");
    if (
      !property ||
      property.organizationIds.length !== 1 ||
      !creator ||
      !context.userIds.has(creator) ||
      !bindings.length ||
      bindings.some(
        (binding) =>
          binding.physicalCapacityCount < 1 ||
          binding.physicalCapacityCount > 500 ||
          binding.inventoryTotal !== binding.physicalCapacityCount,
      )
    )
      continue;
    if (property.latestCalendarRevision !== null && property.latestCalendarRevision > 1) {
      addPmsBlocker(
        context,
        "COHORT_CALENDAR_CONFLICT",
        "pms.hotels",
        hotelId,
        "The target property already has a later operating calendar revision",
      );
      continue;
    }
    const configuration = parsePmsOperatingCalendarConfigurationSnapshot(
      {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        propertyId,
        calendarRevision: 1,
        source: createPmsOperatingCalendarSourceRevision(propertyId, 1),
        sourceInputs: {
          propertyProfile: {
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: propertyId,
            revision: `profile:${property.profileRevision}`,
          },
          propertyTimeZone: property.timeZone,
          roomBindings: bindings.map(({ inventoryTotal: _total, ...binding }) => binding),
        },
        schedule: { mode: "year_round", periods: [] },
        defaultMinimumStayNights: 1,
        createdAt: at,
        updatedAt: at,
      },
      TIME_ZONE_REGISTRY,
    );
    if (!configuration) continue; // no canonical time zone: native setup refuses it too
    calendars.push({ configuration, organizationId: property.organizationIds[0]!, hotel });
  }
  return calendars;
}

/** The rows one native calendar save writes, keyed so reruns plan the same rows. */
export function buildPmsCohortCalendarRecords(
  context: PmsBuildContext,
  calendars: PlannedCohortCalendar[],
): PmsTargetRecord[] {
  return calendars.flatMap(({ configuration, organizationId, hotel }) => {
    const propertyId = configuration.propertyId;
    const at = configuration.createdAt;
    const id = (kind: string) =>
      deterministicUuid("production-pms", "cohort-operating-calendar", kind, propertyId);
    const keyHash = hex(
      `vay1362-migration:${context.sourceRunId}:operating-calendar:${propertyId}`,
    );
    const correlationId = `vay1362-migration:${context.sourceRunId}`;
    const sourceRevision = configuration.source.revision;
    const event = {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      eventType: "pms.operating_calendar.changed",
      destination: PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
      metadata: PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
      propertyId,
      calendarRevision: 1,
      sourceRevision,
    };
    const eventMetadata = {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      ...PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
    };
    const result = {
      ok: true,
      response: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: "created",
        configuration,
        acceptedAt: at,
      },
    };
    const bindings = configuration.sourceInputs.roomBindings;
    const record = (
      table: string,
      targetId: string,
      row: Record<string, unknown>,
      product: "pms" | "platform" = "platform",
    ) =>
      pmsRecord(hotel, table, targetId, at, false, row, { configuration, organizationId }, product);
    return [
      record("idempotency_keys", id("idempotency"), {
        id: id("idempotency"),
        operationScope: "pms",
        operation: PMS_OPERATING_CALENDAR_IDEMPOTENCY.operation,
        keyHash,
        requestFingerprintHash: hex(
          JSON.stringify({
            organizationId,
            propertyId,
            expectedCalendarRevision: 0,
            expectedPropertyProfileRevision: Number(
              configuration.sourceInputs.propertyProfile.revision.slice("profile:".length),
            ),
            schedule: configuration.schedule,
            defaultMinimumStayNights: configuration.defaultMinimumStayNights,
            roomTypeLimits: bindings.map((binding) => ({
              roomTypeId: binding.roomTypeId,
              expectedRoomFactsRevision: binding.sourceRoomFactsRevision,
              expectedRoomUnitsRevision: binding.sourceRoomUnitsRevision,
              startingSellableLimitCount: binding.startingSellableLimitCount,
            })),
          }),
        ),
        status: "completed",
        tenantScope: "property",
        organizationId: null,
        propertyId,
        responseStatusCode: 200,
        responseBodyHash: hex(nativeStableJson(result)),
        correlationId,
        firstSeenAt: at,
        lastSeenAt: at,
        completedAt: at,
        expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString(),
        idempotencyMetadata: { attempt: 1, resultJson: JSON.stringify(result) },
      }),
      record("domain_events", id("event"), {
        id: id("event"),
        sourceSystem: "pms",
        eventKey: `pms.operating-calendar.changed.property.${propertyId}.key.${keyHash}.attempt.1.v1`,
        eventType: "pms.operating_calendar.changed",
        eventVersion: 1,
        occurredAt: at,
        tenantScope: "property",
        organizationId: null,
        propertyId,
        resourceProduct: "pms",
        resourceType: "operating_calendar",
        resourceId: propertyId,
        actorType: "migration",
        actorUserId: null,
        correlationId,
        causationId: context.sourceRunId,
        idempotencyKeyHash: keyHash,
        payload: event,
        eventMetadata,
        privacyScope: "confidential",
      }),
      record("outbox_events", id("outbox"), {
        id: id("outbox"),
        domainEventId: id("event"),
        outboxKey: `${PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION}.pms.operating-calendar.changed.property.${propertyId}.key.${keyHash}.attempt.1.v1`,
        destination: PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
        eventType: "pms.operating_calendar.changed",
        tenantScope: "property",
        organizationId: null,
        propertyId,
        resourceProduct: "pms",
        resourceType: "operating_calendar",
        resourceId: propertyId,
        correlationId,
        idempotencyKeyHash: keyHash,
        payload: event,
        outboxMetadata: eventMetadata,
        createdAt: at,
      }),
      record(
        "operating_calendar_revisions",
        `${propertyId}:1`,
        {
          organizationId,
          propertyId,
          calendarRevision: 1,
          contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
          propertyProfileRevision: Number(
            configuration.sourceInputs.propertyProfile.revision.slice("profile:".length),
          ),
          propertyTimeZone: configuration.sourceInputs.propertyTimeZone,
          scheduleMode: configuration.schedule.mode,
          recurringPeriodCount: configuration.schedule.periods.length,
          roomBindingCount: bindings.length,
          defaultMinimumStayNights: configuration.defaultMinimumStayNights,
          idempotencyKeyId: id("idempotency"),
          domainEventId: id("event"),
          outboxEventId: id("outbox"),
          createdByUserId: uuid(hotel.data["user_id"], "user_id"),
          createdAt: at,
          updatedAt: at,
        },
        "pms",
      ),
      ...bindings.map((binding) =>
        record(
          "operating_calendar_room_bindings",
          `${propertyId}:1:${binding.roomTypeId}`,
          { propertyId, calendarRevision: 1, ...binding },
          "pms",
        ),
      ),
      record("product_audit_events", id("audit"), {
        id: id("audit"),
        auditKey: `pms.operating-calendar.property.${propertyId}.key.${keyHash}.attempt.1.v1`,
        product: "pms",
        action: PMS_OPERATING_CALENDAR_IDEMPOTENCY.operation,
        actionVersion: 1,
        occurredAt: at,
        recordedAt: at,
        tenantScope: "property",
        organizationId: null,
        propertyId,
        actorType: "migration",
        actorUserId: null,
        targetResourceProduct: "pms",
        targetResourceType: "operating_calendar",
        targetResourceId: propertyId,
        secondaryResourceProduct: null,
        secondaryResourceType: null,
        secondaryResourceId: null,
        domainEventId: id("event"),
        externalWebhookEventId: null,
        jobId: null,
        idempotencyKeyId: id("idempotency"),
        correlationId,
        causationId: context.sourceRunId,
        redactedPayload: { propertyId, outcome: "created", calendarRevision: 1, sourceRevision },
        privatePayload: {},
        auditMetadata: {
          migrationRunId: context.sourceRunId,
          actorOrganizationId: organizationId,
          contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        },
        retentionClass: "standard",
        privacyScope: "confidential",
        aiVisible: false,
      }),
    ];
  });
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The native writers' key order (code units), so the response hash matches theirs. */
function nativeStableJson(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
              .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
          )
        : entry;
  return JSON.stringify(sort(value));
}
