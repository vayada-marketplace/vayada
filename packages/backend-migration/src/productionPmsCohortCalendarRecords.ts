import { getTimezone } from "countries-and-timezones";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_IDEMPOTENCY,
  PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
  PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarConfigurationSnapshot,
  parsePmsOperatingSchedule,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingSchedule,
} from "@vayada/domain-pms";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { integer, optionalText, optionalUuid, uuid } from "./productionBookingValues.js";
import { carriedCohortHotel } from "./productionPmsCohortSetup.js";
import { addPmsBlocker, safePmsSourceId } from "./productionPmsContext.js";
import { nativeCommandId, nativeCommandRecords } from "./productionPmsNativeCommand.js";
import type { PmsBuildContext, PmsRoomBuild, PmsTargetRecord } from "./productionPmsTypes.js";
import { jsonArray, pmsRecord } from "./productionPmsValues.js";

// VAY-1362 setup completeness: the operating calendar native hotel setup saves
// (pmsOperatingCalendarCommandRepository): revision 1, the legacy operating periods as its
// schedule, one binding per operating room type at its physical capacity, with the idempotency key, domain event and outbox row its foreign
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
  createdByUserId: string;
  hotel: IdentitySourceRow;
};

const COMMAND = "operating-calendar";
type CohortProperty = NonNullable<PmsBuildContext["target"]["cohortProperties"]>[number];

/**
 * Calendars for carried cohort hotels whose rooms can be bound as native setup binds them. A
 * hotel that cannot (an operating room type without native room facts, without rooms or whose
 * inventory total differs from its rooms; no owner organization, legacy owner user or canonical
 * time zone) gets none and stays in setup. A rerun plans the migrated revision 1 as stored, so
 * later native edits and revisions neither change nor block it; a revision 1 the migration did
 * not write blocks.
 */
export function planPmsCohortCalendars(
  context: PmsBuildContext,
  rooms: Pick<PmsRoomBuild, "records" | "nativeFactsRoomTypes">,
): PlannedCohortCalendar[] {
  if (!context.cohort) return [];
  const properties = new Map(
    (context.target.cohortProperties ?? []).map((row) => [row.propertyId, row]),
  );
  const calendars: PlannedCohortCalendar[] = [];
  for (const hotel of context.rowsByTable.get("hotels") ?? [])
    try {
      const hotelId = uuid(hotel.data["id"], "id");
      const propertyId = context.propertyByHotel.get(hotelId);
      const property = propertyId ? properties.get(propertyId) : undefined;
      if (!property) continue;
      const planned = !carriedCohortHotel(context, hotelId)
        ? null
        : property.storedCalendar
          ? storedCalendar(context, rooms, hotel, hotelId, property)
          : newCalendar(context, rooms, hotel, property);
      if (planned) calendars.push(planned);
      // Without its migrated calendar, the import would plan legacy days over canonical ones.
      else if (
        property.storedCalendar?.idempotencyKeyId ===
        nativeCommandId(COMMAND, "idempotency", property.propertyId)
      )
        addPmsBlocker(
          context,
          "COHORT_CALENDAR_CONFLICT",
          "pms.hotels",
          hotelId,
          "The stored migrated operating calendar is not carried by this run",
        );
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.hotels",
        safePmsSourceId(hotel),
        error instanceof Error ? error.message : "Invalid operating calendar source",
      );
    }
  return calendars;
}

function storedCalendar(
  context: PmsBuildContext,
  rooms: Pick<PmsRoomBuild, "records" | "nativeFactsRoomTypes">,
  hotel: IdentitySourceRow,
  hotelId: string,
  property: CohortProperty,
): PlannedCohortCalendar | null {
  const stored = property.storedCalendar!;
  if (stored.idempotencyKeyId !== nativeCommandId(COMMAND, "idempotency", property.propertyId)) {
    // A calendar saved natively where the import would not plan one is the owner's.
    if (newCalendar(context, rooms, hotel, property))
      addPmsBlocker(
        context,
        "COHORT_CALENDAR_CONFLICT",
        "pms.hotels",
        hotelId,
        "The target property has an operating calendar the migration did not write",
      );
    return null;
  }
  const schedule = parsePmsOperatingSchedule({
    mode: stored.scheduleMode,
    periods: stored.periods,
  });
  if (!schedule) return null;
  return calendar(hotel, property.propertyId, stored.organizationId, stored.createdByUserId, {
    ...stored,
    schedule,
    // jsonb reorders object keys; rebuild them in the order the first run planned.
    bindings: stored.bindings.map((binding) => ({
      roomTypeId: binding.roomTypeId,
      sourceRoomFactsRevision: binding.sourceRoomFactsRevision,
      sourceRoomUnitsRevision: binding.sourceRoomUnitsRevision,
      physicalCapacityCount: binding.physicalCapacityCount,
      startingSellableLimitCount: binding.startingSellableLimitCount,
    })),
    at: new Date(stored.createdAt).toISOString(),
  });
}

function newCalendar(
  context: PmsBuildContext,
  rooms: Pick<PmsRoomBuild, "records" | "nativeFactsRoomTypes">,
  hotel: IdentitySourceRow,
  property: CohortProperty,
): PlannedCohortCalendar | null {
  const existingRoomTypes = new Map(
    context.target.records
      .filter((record) => record.targetTable === "room_types")
      .map((record) => [record.targetId, record.row]),
  );
  const roomTypes = rooms.records.filter(
    (record) =>
      record.targetTable === "room_types" &&
      record.row["propertyId"] === property.propertyId &&
      record.row["active"] === true,
  );
  if (roomTypes.some((roomType) => !rooms.nativeFactsRoomTypes?.has(roomType.targetId)))
    return null;
  const bindings = roomTypes
    .map((roomType) => {
      const capacity = rooms.records.filter(
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
        inventoryTotal: integer(
          context.roomTypeById.get(roomType.targetId)?.data["total_rooms"],
          "total_rooms",
          0,
        ),
      };
    })
    .sort((left, right) => (left.roomTypeId < right.roomTypeId ? -1 : 1));
  const creator = optionalUuid(hotel.data["user_id"], "user_id");
  if (
    property.organizationIds.length !== 1 ||
    !property.timeZone ||
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
    return null;
  // Legacy operating periods belong to room types; the calendar's schedule is the property's.
  const schedule = legacySchedule(
    roomTypes.map((roomType) => context.roomTypeById.get(roomType.targetId)?.data ?? {}),
  );
  if (!schedule) return null;
  return calendar(hotel, property.propertyId, property.organizationIds[0]!, creator, {
    profileRevision: property.profileRevision,
    timeZone: property.timeZone,
    schedule,
    defaultMinimumStayNights: 1,
    bindings: bindings.map(({ inventoryTotal: _total, ...binding }) => binding),
    at: new Date(context.completedAt).toISOString(),
  });
}

function calendar(
  hotel: IdentitySourceRow,
  propertyId: string,
  organizationId: string,
  createdByUserId: string,
  input: {
    profileRevision: number;
    timeZone: string;
    schedule: PmsOperatingSchedule;
    defaultMinimumStayNights: number;
    bindings: PmsOperatingCalendarRoomBinding[];
    at: string;
  },
): PlannedCohortCalendar | null {
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
          revision: `profile:${input.profileRevision}`,
        },
        propertyTimeZone: input.timeZone,
        roomBindings: input.bindings,
      },
      schedule: input.schedule,
      defaultMinimumStayNights: input.defaultMinimumStayNights,
      createdAt: input.at,
      updatedAt: input.at,
    },
    TIME_ZONE_REGISTRY,
  );
  // No canonical time zone: native setup refuses it too.
  return configuration ? { configuration, organizationId, createdByUserId, hotel } : null;
}

/** The rows one native calendar save writes, keyed so reruns plan the same rows. */
export function buildPmsCohortCalendarRecords(
  context: PmsBuildContext,
  calendars: PlannedCohortCalendar[],
): PmsTargetRecord[] {
  return calendars.flatMap(({ configuration, organizationId, createdByUserId, hotel }) => {
    const { propertyId, createdAt: at } = configuration;
    const bindings = configuration.sourceInputs.roomBindings;
    const profileRevision = Number(
      configuration.sourceInputs.propertyProfile.revision.slice("profile:".length),
    );
    const sourceRevision = configuration.source.revision;
    const result = {
      ok: true,
      response: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: "created",
        configuration,
        acceptedAt: at,
      },
    };
    const checksumInput = { configuration, organizationId };
    const command = nativeCommandRecords(context, {
      source: hotel,
      propertyId,
      name: COMMAND,
      at,
      operation: PMS_OPERATING_CALENDAR_IDEMPOTENCY.operation,
      fingerprint: JSON.stringify({
        organizationId,
        propertyId,
        expectedCalendarRevision: 0,
        expectedPropertyProfileRevision: profileRevision,
        schedule: configuration.schedule,
        defaultMinimumStayNights: configuration.defaultMinimumStayNights,
        roomTypeLimits: bindings.map((binding) => ({
          roomTypeId: binding.roomTypeId,
          expectedRoomFactsRevision: binding.sourceRoomFactsRevision,
          expectedRoomUnitsRevision: binding.sourceRoomUnitsRevision,
          startingSellableLimitCount: binding.startingSellableLimitCount,
        })),
      }),
      result,
      replay: { resultJson: JSON.stringify(result) },
      eventType: "pms.operating_calendar.changed",
      resourceType: "operating_calendar",
      payload: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        eventType: "pms.operating_calendar.changed",
        destination: PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
        metadata: PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
        propertyId,
        calendarRevision: 1,
        sourceRevision,
      },
      metadata: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        ...PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
      },
      destination: PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
      eventKey: (key) =>
        `pms.operating-calendar.changed.property.${propertyId}.key.${key}.attempt.1.v1`,
      outboxKey: (key) =>
        `${PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION}.pms.operating-calendar.changed.property.${propertyId}.key.${key}.attempt.1.v1`,
      auditKey: (key) => `pms.operating-calendar.property.${propertyId}.key.${key}.attempt.1.v1`,
      redactedPayload: { propertyId, outcome: "created", calendarRevision: 1, sourceRevision },
      auditMetadata: {
        actorOrganizationId: organizationId,
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      },
      checksumInput,
    });
    const record = (table: string, targetId: string, row: Record<string, unknown>) =>
      pmsRecord(hotel, table, targetId, at, false, row, checksumInput);
    return [
      ...command.records,
      record("operating_calendar_revisions", `${propertyId}:1`, {
        organizationId,
        propertyId,
        calendarRevision: 1,
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        propertyProfileRevision: profileRevision,
        propertyTimeZone: configuration.sourceInputs.propertyTimeZone,
        scheduleMode: configuration.schedule.mode,
        recurringPeriodCount: configuration.schedule.periods.length,
        roomBindingCount: bindings.length,
        defaultMinimumStayNights: configuration.defaultMinimumStayNights,
        idempotencyKeyId: command.ids.idempotency,
        domainEventId: command.ids.event,
        outboxEventId: command.ids.outbox,
        createdByUserId,
        createdAt: at,
        updatedAt: at,
      }),
      ...configuration.schedule.periods.map((period, index) =>
        record("operating_calendar_recurring_periods", `${propertyId}:1:${index}`, {
          propertyId,
          calendarRevision: 1,
          periodIndex: index,
          startMonth: Number(period.startsOn.slice(0, 2)),
          startDay: Number(period.startsOn.slice(3, 5)),
          endMonth: Number(period.endsOn.slice(0, 2)),
          endDay: Number(period.endsOn.slice(3, 5)),
        }),
      ),
      ...bindings.map((binding) =>
        record("operating_calendar_room_bindings", `${propertyId}:1:${binding.roomTypeId}`, {
          propertyId,
          calendarRevision: 1,
          ...binding,
        }),
      ),
    ];
  });
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The days of a non-leap year as MM-DD, the form legacy operatingOn compares. */
const YEAR_DAYS = MONTH_LENGTHS.flatMap((length, month) =>
  Array.from(
    { length },
    (_, day) => `${String(month + 1).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`,
  ),
);

/**
 * The recurring schedule the legacy operating periods of the bound room types express, read on
 * each day of a non-leap year exactly as legacy inventory operatingOn reads them (string order
 * of MM-DD, wrapping when from > to, a period without both days ignored, no periods meaning open
 * all year), canonicalized by the native parser. Null when the room types disagree, the year has
 * no open day, or the native contract refuses the periods (more than 24): the property schedule
 * cannot carry them, so the hotel gets no calendar. 29 February has no recurring day of its own;
 * inventory keeps it closed where legacy does (manual 0 on a schedule-open day).
 */
export function legacySchedule(roomTypes: Record<string, unknown>[]): PmsOperatingSchedule | null {
  const years = roomTypes.map((data) => {
    const periods = jsonArray(data["operating_periods"], "operating_periods").map(
      (period, index) => {
        if (!period || typeof period !== "object" || Array.isArray(period))
          throw new Error(`operating_periods[${index}] must be an object`);
        const value = period as Record<string, unknown>;
        return {
          from: optionalText(value["from"], "period.from"),
          to: optionalText(value["to"], "period.to"),
        };
      },
    );
    if (!periods.length) return YEAR_DAYS.map(() => true);
    return YEAR_DAYS.map((monthDay) =>
      periods.some(({ from, to }) =>
        !from || !to
          ? false
          : from > to
            ? monthDay >= from || monthDay <= to
            : monthDay >= from && monthDay <= to,
      ),
    );
  });
  const [year] = years;
  if (!year || years.some((other) => other.join() !== year.join()) || !year.includes(true))
    return null;
  if (!year.includes(false)) return parsePmsOperatingSchedule({ mode: "year_round", periods: [] });
  const periods: { startsOn: string; endsOn: string }[] = [];
  const firstClosed = year.indexOf(false);
  let start: number | null = null;
  for (let offset = 1; offset <= 365; offset += 1) {
    const day = (firstClosed + offset) % 365;
    if (year[day] && start === null) start = day;
    if (start !== null && !year[(day + 1) % 365]) {
      periods.push({ startsOn: YEAR_DAYS[start]!, endsOn: YEAR_DAYS[day]! });
      start = null;
    }
  }
  return parsePmsOperatingSchedule({ mode: "recurring", periods });
}
