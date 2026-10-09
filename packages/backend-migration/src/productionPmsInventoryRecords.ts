import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  bool,
  date,
  integer,
  iso,
  optionalDate,
  optionalIso,
  optionalText,
  uuid,
} from "./productionBookingValues.js";
import { dateOverlaps, dates, jsonArray, jsonMap, pmsRecord } from "./productionPmsValues.js";
import type { PlannedCohortCalendar } from "./productionPmsCohortCalendarRecords.js";
import {
  PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingSchedule,
} from "@vayada/domain-pms";

const INVENTORY_STATUSES = new Set(["pending", "confirmed", "checked_in", "in_house"]);

export type CohortInventoryHorizon = {
  from: string;
  through: string;
  windowThrough: string | null;
};
export type HorizonedCohortCalendar = PlannedCohortCalendar & { horizon: CohortInventoryHorizon };

/**
 * VAY-1362: the planned calendars with their horizon. A calendar whose inventory the native jobs
 * could not carry blocks the run (the legacy data must be fixed before the extraction): coverage
 * past the auto-open worker's 24-month maximum stops the hotel's auto-open, and a room type the
 * calendar does not bind that holds bookings, drafts, blocks or stored days in the coverage, or a
 * bound one with stored days past it, leaves legacy-shaped days the native calendar save and
 * materializer refuse.
 */
export function withCohortInventoryHorizons(
  context: PmsBuildContext,
  calendars: PlannedCohortCalendar[],
): HorizonedCohortCalendar[] {
  const properties = new Map(
    (context.target.cohortProperties ?? []).map((row) => [row.propertyId, row]),
  );
  return calendars.flatMap((calendar) => {
    const { propertyId, sourceInputs } = calendar.configuration;
    const hotelId = String(calendar.hotel.data["id"]).toLowerCase();
    try {
      const horizon = cohortInventoryHorizon(context, calendar);
      const bound = new Set(sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId));
      const stored = Object.entries(
        properties.get(propertyId)?.inventoryThroughByRoomType ?? {},
      ).some(([roomTypeId, last]) =>
        bound.has(roomTypeId) ? last > horizon.through : last >= horizon.from,
      );
      const consumed = (context.rowsByTable.get("room_types") ?? []).some((roomType) => {
        const roomTypeId = String(roomType.data["id"]).toLowerCase();
        return (
          String(roomType.data["hotel_id"]).toLowerCase() === hotelId &&
          !bound.has(roomTypeId) &&
          (["bookings", "booking_drafts", "room_blocks"] as const).some((table) =>
            rowsForRoomType(context, table, roomTypeId).some((row) =>
              consumesRange(context, row, horizon),
            ),
          )
        );
      });
      const days = (Date.parse(horizon.through) - Date.parse(horizon.from)) / 86_400_000 + 1;
      if (days <= PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS && !stored && !consumed)
        return [{ ...calendar, horizon }];
      addPmsBlocker(
        context,
        "COHORT_INVENTORY_NOT_CARRIED",
        "pms.hotels",
        hotelId,
        stored || consumed
          ? "Inventory outside the migrated calendar's bindings or coverage cannot be carried"
          : `Inventory coverage exceeds ${PMS_CALENDAR_AUTO_OPEN_MAX_HORIZON_DAYS} days`,
      );
      return [];
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.hotels",
        safePmsSourceId(calendar.hotel),
        error instanceof Error ? error.message : "Invalid cohort inventory horizon",
      );
      return [];
    }
  });
}

export function buildPmsInventoryRecords(
  context: PmsBuildContext,
  calendars: HorizonedCohortCalendar[] = [],
): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  const canonical = new Map(
    calendars.flatMap((calendar) =>
      calendar.configuration.sourceInputs.roomBindings.map(
        (binding) =>
          [binding.roomTypeId, { calendar, binding, horizon: calendar.horizon }] as const,
      ),
    ),
  );
  const calendared = new Map(
    calendars.map(({ configuration, horizon }) => [configuration.propertyId, horizon]),
  );
  blockActiveDrafts(context, calendared);
  const existingInventory = new Map(
    context.target.records
      .filter((record) => record.targetTable === "inventory_days")
      .map((record) => [record.targetId, record]),
  );
  for (const source of context.rowsByTable.get("room_types") ?? []) {
    try {
      const facts = inventoryFacts(context, source);
      const bound = canonical.get(facts.roomTypeId);
      // A calendared property keeps no legacy-shaped day of an unbound (inactive) room type: the
      // native materializer refuses one when the type is bound again.
      if (!bound && calendared.has(facts.propertyId)) continue;
      const bounded = bound?.horizon ?? propertyHorizon(context.snapshotAt, facts.hotel);
      for (const stayDate of dates(bounded.from, bounded.through))
        records.push(inventoryDay(context, source, facts, stayDate, existingInventory, bound));
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.room_types",
        safePmsSourceId(source),
        error instanceof Error ? error.message : "Invalid PMS inventory source",
      );
    }
  }
  return records;
}

type InventoryFacts = {
  propertyId: string;
  roomTypeId: string;
  totalCount: number;
  bookings: IdentitySourceRow[];
  drafts: IdentitySourceRow[];
  blocks: IdentitySourceRow[];
  linkedActivity: IdentitySourceRow[];
  hotel: IdentitySourceRow;
  checksumInput: unknown;
  effectiveRoomTypeActive: boolean;
};

function inventoryFacts(context: PmsBuildContext, source: IdentitySourceRow): InventoryFacts {
  const roomTypeId = uuid(source.data["id"], "id");
  const hotelId = uuid(source.data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const hotel = context.hotelById.get(hotelId);
  if (!hotel) throw new Error(`hotels ${hotelId} source is missing`);
  const totalCount = integer(source.data["total_rooms"], "total_rooms", 0);
  if (totalCount < 0 || totalCount > 500) throw new Error("total_rooms must be between 0 and 500");
  const bookings = rowsForRoomType(context, "bookings", roomTypeId);
  const drafts = rowsForRoomType(context, "booking_drafts", roomTypeId);
  const blocks = rowsForRoomType(context, "room_blocks", roomTypeId);
  const linkedGroupId = context.linkedGroupByRoomType.get(roomTypeId);
  const linkedMembers = linkedGroupId
    ? [...context.linkedGroupByRoomType.entries()]
        .filter(([, groupId]) => groupId === linkedGroupId)
        .map(([member]) => member)
    : [];
  const linkedActivity = linkedMembers.flatMap((member) => [
    ...rowsForRoomType(context, "bookings", member),
    ...rowsForRoomType(context, "booking_drafts", member),
    ...rowsForRoomType(context, "room_blocks", member),
  ]);
  for (const row of [...bookings, ...drafts, ...blocks]) {
    const rowHotelId = String(row.data["hotel_id"] ?? hotelId).toLowerCase();
    if (rowHotelId !== hotelId) throw new Error(`${row.sourceTable} crosses hotel inventory scope`);
  }
  return {
    propertyId,
    roomTypeId,
    totalCount,
    bookings,
    drafts,
    blocks,
    linkedActivity,
    hotel,
    effectiveRoomTypeActive:
      context.effectiveRoomTypeActiveById.get(roomTypeId) ??
      bool(source.data["is_active"], "is_active", true),
    checksumInput: {
      hotel: hotel.data,
      roomType: source.data,
      bookings: bookings.map((row) => row.data),
      drafts: drafts.map((row) => row.data),
      blocks: blocks.map((row) => row.data),
      linkedActivity: linkedActivity.map((row) => ({ table: row.sourceTable, row: row.data })),
      effectiveRoomTypeActive: context.effectiveRoomTypeActiveById.get(roomTypeId) ?? null,
    },
  };
}

function inventoryDay(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  facts: InventoryFacts,
  stayDate: string,
  existingInventory: Map<string, PmsBuildContext["target"]["records"][number]>,
  bound?: {
    calendar: PlannedCohortCalendar;
    binding: PmsOperatingCalendarRoomBinding;
    horizon: CohortInventoryHorizon;
  },
): PmsTargetRecord {
  const assignedCount = facts.bookings
    .filter((row) => activeBooking(context, row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["number_of_rooms"], "number_of_rooms", 1), 0);
  const blockedCount = facts.blocks
    .filter((row) => activeBlock(row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["blocked_count"], "blocked_count", 1), 0);
  const softHeldCount = facts.drafts
    .filter((row) => activeDraft(context, row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["number_of_rooms"], "number_of_rooms", 1), 0);
  const linkedStopSell = facts.linkedActivity.some((row) => {
    if (row.sourceTable === "bookings") return activeBooking(context, row, stayDate);
    if (row.sourceTable === "booking_drafts") return activeDraft(context, row, stayDate);
    return activeBlock(row, stayDate);
  });
  const calendarOpen =
    facts.effectiveRoomTypeActive && sellableAtSnapshot(context, source, facts.hotel, stayDate);
  if (assignedCount > facts.totalCount)
    throw new Error(
      `${stayDate} assigned (${assignedCount}) exceeds total_rooms (${facts.totalCount})`,
    );
  const overCapacity = assignedCount + blockedCount > facts.totalCount;
  // Legacy can contain duplicate historical blocks. Preserve their raw total as evidence,
  // but never increase capacity or let an impossible envelope become sellable in the target.
  const migratedBlockedCount = overCapacity
    ? Math.max(0, facts.totalCount - assignedCount)
    : blockedCount;
  const availableCount =
    calendarOpen && !linkedStopSell && !overCapacity
      ? Math.max(0, facts.totalCount - assignedCount - migratedBlockedCount - softHeldCount)
      : 0;
  const status = calendarOpen && !overCapacity ? "open" : "closed";
  const targetId = `${facts.propertyId}:${facts.roomTypeId}:${stayDate}`;
  const linkedSourceRevision = nextLinkedSourceRevision(
    existingInventory.get(targetId),
    linkedStopSell,
  );
  // VAY-1362: a cohort room type bound by the migrated operating calendar takes the canonical
  // shape native materialization writes at calendar revision 1 (newDay), so the materializer and
  // the VAY-2066 auto-open job adopt it. Its status follows the calendar's schedule, which
  // carries the legacy operating periods. Other days legacy does not sell at the snapshot
  // (stop-sells, closed dates, a day past its auto-open window) survive the job's rewrite of
  // generated counts as a manual limit of 0. Within a year, a rolling window is not one: the
  // producer moves it with the same month-end rule.
  const canonical = bound
    ? canonicalCounts(bound.binding, {
        open: scheduledOpen(bound.calendar.configuration.schedule, stayDate),
        assignedCount,
        blockedCount: migratedBlockedCount,
        linkedStopSell,
        closed:
          overCapacity ||
          !facts.effectiveRoomTypeActive ||
          !operatingOn(source, stayDate) ||
          !sellableAtSnapshot(context, source, facts.hotel, stayDate, {
            windowThrough: bound.horizon.windowThrough,
            timeZone: bound.calendar.configuration.sourceInputs.propertyTimeZone,
          }),
      })
    : null;
  return pmsRecord(
    source,
    "inventory_days",
    targetId,
    context.completedAt,
    true,
    {
      propertyId: facts.propertyId,
      roomTypeId: facts.roomTypeId,
      stayDate,
      totalCount: facts.totalCount,
      assignedCount,
      blockedCount: migratedBlockedCount,
      availableCount,
      status,
      sourceFreshness: {
        migrationRunId: context.sourceRunId,
        sourceSnapshotAt: context.snapshotAt,
        sourceCompletedAt: context.completedAt,
        legacy: {
          assignedCount,
          blockedCount,
          softHeldCount,
          linkedStopSell,
          calendarOpen,
          effectiveRoomTypeActive: facts.effectiveRoomTypeActive,
          ...(overCapacity
            ? {
                migratedBlockedCount,
                migrationDisposition: "legacy_over_capacity_closed",
              }
            : {}),
        },
      },
      updatedAt: context.completedAt,
      calendarRevision: null,
      inventoryRevision: null,
      generatedSellableLimitCount: null,
      channelSellableLimitCount: null,
      manualSellableLimitCount: null,
      effectiveSellableLimitCount: null,
      generatedSourceRevision: null,
      channelSourceRevision: null,
      manualSourceRevision: null,
      blockSourceRevision: null,
      bookingSourceRevision: null,
      linkedStopSell,
      linkedSourceRevision,
      ...canonical,
    },
    canonical
      ? {
          inventory: facts.checksumInput,
          stayDate,
          binding: bound!.binding,
          schedule: bound!.calendar.configuration.schedule,
        }
      : { inventory: facts.checksumInput, stayDate },
  );
}

function canonicalCounts(
  binding: PmsOperatingCalendarRoomBinding,
  day: {
    open: boolean;
    assignedCount: number;
    blockedCount: number;
    linkedStopSell: boolean;
    closed: boolean;
  },
): Record<string, unknown> {
  const generated = binding.startingSellableLimitCount;
  const manual = day.open && day.closed ? 0 : null;
  const effective = manual ?? generated;
  return {
    totalCount: binding.physicalCapacityCount,
    availableCount:
      !day.open || day.linkedStopSell
        ? 0
        : Math.max(0, effective - day.assignedCount - day.blockedCount),
    status: day.open ? "open" : "closed",
    calendarRevision: 1,
    inventoryRevision: 1,
    generatedSellableLimitCount: generated,
    channelSellableLimitCount: null,
    manualSellableLimitCount: manual,
    effectiveSellableLimitCount: effective,
    generatedSourceRevision: 1,
    channelSourceRevision: 0,
    manualSourceRevision: manual === null ? 0 : 1,
    blockSourceRevision: day.blockedCount > 0 ? 1 : 0,
    bookingSourceRevision: day.assignedCount > 0 ? 1 : 0,
  };
}

function nextLinkedSourceRevision(
  current: PmsBuildContext["target"]["records"][number] | undefined,
  linkedStopSell: boolean,
): number {
  if (!current) return linkedStopSell ? 1 : 0;
  const previous = current.row["linkedStopSell"] === true;
  const revision = integer(current.row["linkedSourceRevision"], "linked_source_revision", 0);
  if (previous === linkedStopSell) return revision;
  if (revision >= 2_147_483_647) throw new Error("linked_source_revision is exhausted");
  return revision + 1;
}

function blockActiveDrafts(
  context: PmsBuildContext,
  calendared: Map<string, CohortInventoryHorizon>,
): void {
  for (const draft of context.rowsByTable.get("booking_drafts") ?? []) {
    try {
      if (
        draft.data["materialized_booking_id"] !== null &&
        draft.data["materialized_booking_id"] !== undefined
      )
        continue;
      const expiresAt = optionalIso(draft.data["expires_at"], "expires_at");
      if (!expiresAt || Date.parse(expiresAt) <= Date.parse(context.snapshotAt)) continue;
      const hotelId = uuid(draft.data["hotel_id"], "hotel_id");
      const hotel = context.hotelById.get(hotelId);
      if (!hotel) throw new Error(`hotels ${hotelId} source is missing`);
      // A calendared cohort hotel's coverage (its calendar's clock) reaches every live hold.
      const coverage = calendared.get(context.propertyByHotel.get(hotelId) ?? "");
      const bounded = coverage ?? propertyHorizon(context.snapshotAt, hotel);
      const checkIn = date(draft.data["check_in"], "check_in");
      const checkOut = date(draft.data["check_out"], "check_out");
      if (checkOut <= bounded.from || (!coverage && checkIn > bounded.through)) continue;
      addPmsBlocker(
        context,
        "ACTIVE_BOOKING_DRAFT",
        "pms.booking_drafts",
        safePmsSourceId(draft),
        "Active legacy inventory hold must expire or materialize before cutover extraction",
      );
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.booking_drafts",
        safePmsSourceId(draft),
        error instanceof Error ? error.message : "Invalid booking draft hold",
      );
    }
  }
}

function rowsForRoomType(
  context: PmsBuildContext,
  table: string,
  roomTypeId: string,
): IdentitySourceRow[] {
  return (context.rowsByTable.get(table) ?? []).filter(
    (row) => String(row.data["room_type_id"] ?? "").toLowerCase() === roomTypeId,
  );
}

function liveBooking(context: PmsBuildContext, row: IdentitySourceRow): boolean {
  const status = String(row.data["status"] ?? "").toLowerCase();
  if (!INVENTORY_STATUSES.has(status)) return false;
  return !(
    status === "pending" &&
    String(row.data["payment_status"] ?? "unpaid").toLowerCase() === "unpaid" &&
    Date.parse(iso(row.data["created_at"], "created_at")) <
      Date.parse(context.snapshotAt) - 30 * 60_000
  );
}

function activeBooking(
  context: PmsBuildContext,
  row: IdentitySourceRow,
  stayDate: string,
): boolean {
  if (!liveBooking(context, row)) return false;
  return dateOverlaps(
    date(row.data["check_in"], "check_in"),
    date(row.data["check_out"], "check_out"),
    stayDate,
  );
}

function liveDraft(context: PmsBuildContext, row: IdentitySourceRow): boolean {
  if (
    row.data["materialized_booking_id"] !== null &&
    row.data["materialized_booking_id"] !== undefined
  )
    return false;
  const expiresAt = optionalIso(row.data["expires_at"], "expires_at");
  return !!expiresAt && Date.parse(expiresAt) > Date.parse(context.completedAt);
}

function activeDraft(context: PmsBuildContext, row: IdentitySourceRow, stayDate: string): boolean {
  if (!liveDraft(context, row)) return false;
  return dateOverlaps(
    date(row.data["check_in"], "check_in"),
    date(row.data["check_out"], "check_out"),
    stayDate,
  );
}

/** A live booking, draft or block holds a day in the range (end dates are exclusive). */
function consumesRange(
  context: PmsBuildContext,
  row: IdentitySourceRow,
  range: { from: string; through: string },
): boolean {
  const block = row.sourceTable === "room_blocks";
  if (row.sourceTable === "bookings" && !liveBooking(context, row)) return false;
  if (row.sourceTable === "booking_drafts" && !liveDraft(context, row)) return false;
  const start = date(row.data[block ? "start_date" : "check_in"], "start");
  const end = date(row.data[block ? "end_date" : "check_out"], "end");
  return end > range.from && start <= range.through;
}

function activeBlock(row: IdentitySourceRow, stayDate: string): boolean {
  return dateOverlaps(
    date(row.data["start_date"], "start_date"),
    date(row.data["end_date"], "end_date"),
    stayDate,
  );
}

function operatingOn(source: IdentitySourceRow, stayDate: string): boolean {
  const periods = jsonArray(source.data["operating_periods"], "operating_periods");
  if (!periods.length) return true;
  const monthDay = stayDate.slice(5);
  return periods.some((period, index) => {
    if (!period || typeof period !== "object" || Array.isArray(period))
      throw new Error(`operating_periods[${index}] must be an object`);
    const from = optionalText((period as Record<string, unknown>)["from"], "period.from");
    const to = optionalText((period as Record<string, unknown>)["to"], "period.to");
    if (!from || !to) return false;
    return from > to ? monthDay >= from || monthDay <= to : monthDay >= from && monthDay <= to;
  });
}

/** canonical: on the calendar's clock; the schedule carries the operating periods, and only the
 * horizon's auto-open window closes days. */
function sellableAtSnapshot(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  hotel: IdentitySourceRow,
  stayDate: string,
  canonical?: { windowThrough: string | null; timeZone: string },
): boolean {
  if (!bool(source.data["is_active"], "is_active", true)) return false;
  const clock = propertyClock(context.snapshotAt, canonical?.timeZone ?? hotel.data["timezone"]);
  if (sameDayClosed(hotel, stayDate, clock)) return false;
  const minimum = integer(source.data["minimum_advance_days"], "minimum_advance_days", 0);
  const daysAhead =
    (Date.parse(`${stayDate}T00:00:00Z`) - Date.parse(`${clock.today}T00:00:00Z`)) / 86_400_000;
  if (daysAhead < minimum) return false;
  if (canonical)
    return (
      (!canonical.windowThrough || stayDate <= canonical.windowThrough) &&
      resolvedRate(source, stayDate) > 0
    );
  if (!operatingOn(source, stayDate)) return false;
  if (bool(hotel.data["calendar_auto_open_enabled"], "calendar_auto_open_enabled", false)) {
    const openThrough = optionalDate(
      hotel.data["calendar_auto_open_through"],
      "calendar_auto_open_through",
    );
    if (openThrough && stayDate > openThrough) return false;
  }
  return resolvedRate(source, stayDate) > 0;
}

/** The native end of a legacy fixed auto-open window: the end of its month; null otherwise. */
function fixedWindowEnd(hotel: IdentitySourceRow): string | null {
  const month = optionalDate(
    hotel.data["calendar_auto_open_fixed_month"],
    "calendar_auto_open_fixed_month",
  );
  if (
    !month ||
    !bool(hotel.data["calendar_auto_open_enabled"], "calendar_auto_open_enabled", false) ||
    optionalText(hotel.data["calendar_auto_open_mode"], "calendar_auto_open_mode") !== "fixed"
  )
    return null;
  const end = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return end.toISOString().slice(0, 10);
}

/** The native operating status of a day (inventoryMaterializationPlanner operatingStatusFor). */
function scheduledOpen(schedule: PmsOperatingSchedule, stayDate: string): boolean {
  if (schedule.mode === "year_round") return true;
  const monthDay = stayDate.slice(5);
  return schedule.periods.some(({ startsOn, endsOn }) =>
    startsOn <= endsOn
      ? monthDay >= startsOn && monthDay <= endsOn
      : monthDay >= startsOn || monthDay <= endsOn,
  );
}

/**
 * The days a calendared cohort hotel gets canonically, in the calendar's time zone as the native
 * jobs count them: from the snapshot's local day for a year (365 more days), or only through a
 * fixed auto-open window's end, but always through the last day a legacy booking, draft or
 * block holds, so extending the coverage later never meets a day without its consumers.
 * windowThrough: the last day legacy sells, for the days past the year: a fixed window's month
 * end, else a rolling window's legacy end (at least the year); null without a window.
 */
export function cohortInventoryHorizon(
  context: PmsBuildContext,
  calendar: PlannedCohortCalendar,
): CohortInventoryHorizon {
  const from = propertyClock(
    context.snapshotAt,
    calendar.configuration.sourceInputs.propertyTimeZone,
  ).today;
  const shift = (day: string, days: number) => {
    const value = new Date(`${day}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const year = shift(from, 365);
  let through = year;
  const fixedEnd = fixedWindowEnd(calendar.hotel);
  if (fixedEnd && fixedEnd < through) through = fixedEnd < from ? from : fixedEnd;
  const rollingEnd = bool(
    calendar.hotel.data["calendar_auto_open_enabled"],
    "calendar_auto_open_enabled",
    false,
  )
    ? optionalDate(calendar.hotel.data["calendar_auto_open_through"], "calendar_auto_open_through")
    : null;
  const windowThrough = fixedEnd ?? (rollingEnd && rollingEnd < year ? year : rollingEnd);
  const hotelId = String(calendar.hotel.data["id"]).toLowerCase();
  for (const table of ["bookings", "booking_drafts", "room_blocks"])
    for (const row of context.rowsByTable.get(table) ?? []) {
      if (String(row.data["hotel_id"] ?? "").toLowerCase() !== hotelId) continue;
      const live =
        table === "room_blocks" ||
        (table === "bookings" ? liveBooking(context, row) : liveDraft(context, row));
      const end = optionalDate(row.data[table === "room_blocks" ? "end_date" : "check_out"], "end");
      if (live && end && shift(end, -1) > through) through = shift(end, -1);
    }
  return { from, through, windowThrough };
}

export function propertyHorizon(
  snapshotAt: string,
  hotel: IdentitySourceRow,
): { from: string; through: string } {
  const from = propertyClock(snapshotAt, hotel.data["timezone"]).today;
  const through = new Date(`${from}T00:00:00Z`);
  through.setUTCDate(through.getUTCDate() + 365);
  return { from, through: through.toISOString().slice(0, 10) };
}

export function propertyClock(
  snapshotAt: string,
  timezoneValue: unknown,
): { today: string; time: string } {
  const instant = new Date(iso(snapshotAt, "snapshotAt"));
  const configured = optionalText(timezoneValue, "timezone") ?? "UTC";
  const parts = clockParts(instant, configured) ?? clockParts(instant, "UTC")!;
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function clockParts(
  instant: Date,
  timeZone: string,
): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    return Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function sameDayClosed(
  hotel: IdentitySourceRow,
  stayDate: string,
  clock: { today: string; time: string },
): boolean {
  if (stayDate !== clock.today) return false;
  if (!bool(hotel.data["same_day_bookings_enabled"], "same_day_bookings_enabled", true))
    return true;
  const cutoff = optionalText(
    hotel.data["same_day_booking_cutoff_time"],
    "same_day_booking_cutoff_time",
  );
  if (!cutoff) return false;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoff))
    throw new Error("same_day_booking_cutoff_time must be HH:MM");
  return clock.time >= `${cutoff}:00`;
}

function resolvedRate(source: IdentitySourceRow, stayDate: string): number {
  const daily = jsonMap(source.data["daily_rates"], "daily_rates");
  if (daily[stayDate] !== null && daily[stayDate] !== undefined)
    return numeric(daily[stayDate], `daily_rates.${stayDate}`);
  const seasons = jsonArray(source.data["seasons"], "seasons").map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`seasons[${index}] must be an object`);
    return value as Record<string, unknown>;
  });
  for (const season of seasons) {
    if (!season["rate"] || !seasonCovers(season, stayDate)) continue;
    const rate = Number(season["rate"]);
    if (Number.isFinite(rate)) return rate;
  }
  let baseRate = numeric(source.data["base_rate"], "base_rate");
  if (baseRate === 0 && seasons.length > 0) {
    const positive = seasons
      .map((season) => Number(season["rate"]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (positive.length > 0) baseRate = Math.min(...positive);
  }
  return baseRate;
}

function seasonCovers(season: Record<string, unknown>, stayDate: string): boolean {
  const from = optionalText(season["from"], "season.from");
  const to = optionalText(season["to"], "season.to");
  if (!from || !to) return false;
  const year = stayDate.slice(0, 4);
  const startsOn = seasonDate(from, year);
  const endsOn = seasonDate(to, year);
  if (!startsOn || !endsOn) return false;
  return startsOn > endsOn
    ? stayDate >= startsOn || stayDate <= endsOn
    : stayDate >= startsOn && stayDate <= endsOn;
}

function seasonDate(value: string, year: string): string | null {
  const monthDay = value.length <= 5 ? value : value.slice(5, 10);
  if (!/^\d{2}-\d{2}$/.test(monthDay)) return null;
  const candidate = `${year}-${monthDay}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function numeric(value: unknown, field: string): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
  return parsed;
}
