import { describe, expect, it } from "vitest";
import { planPmsInventoryMaterialization, type PmsInventoryDaySnapshot } from "@vayada/domain-pms";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planPmsCohortCalendars } from "./productionPmsCohortCalendarRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import {
  cohortInventoryHorizon,
  withCohortInventoryHorizons,
} from "./productionPmsInventoryRecords.js";
import { buildPmsRoomRecords } from "./productionPmsRoomRecords.js";
import type { PmsTargetRecord, ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const ROOM_TYPE = "30000000-0000-4000-a000-000000000001";
const ROOM = "40000000-0000-4000-a000-00000000000";
const OWNER = "50000000-0000-4000-a000-000000000001";
const ORGANIZATION = "60000000-0000-4000-a000-000000000001";
const BLOCK = "70000000-0000-4000-a000-000000000001";
const AT = "2026-10-09T08:00:00.000Z";

const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
  sourceDatabase: "pms",
  sourceTable,
  rowOrdinal: 1,
  data: { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...data },
});

function sourceRows(hotel: Record<string, unknown> = {}, roomType: Record<string, unknown> = {}) {
  return [
    row("hotels", { id: HOTEL, timezone: "Europe/Berlin", user_id: OWNER, ...hotel }),
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Double",
      total_rooms: 2,
      base_rate: "100",
      currency: "EUR",
      bed_type: "1 Double Bed",
      // Closed every year from 1 to 31 January.
      operating_periods: [{ from: "02-01", to: "12-31" }],
      ...roomType,
    }),
    ...[1, 2].map((index) =>
      row("rooms", {
        id: `${ROOM}${index}`,
        hotel_id: HOTEL,
        room_type_id: ROOM_TYPE,
        room_number: `${100 + index}`,
      }),
    ),
    row("room_blocks", {
      id: BLOCK,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      start_date: "2026-11-01",
      end_date: "2026-11-03",
      blocked_count: 1,
      reason: "maintenance",
    }),
  ];
}

function target(): ProductionPmsTargetState {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: "run",
        migrationDisposition: "canonical",
        ownerStatus: "active",
      },
    ],
    cohortProperties: [
      {
        propertyId: PROPERTY,
        profileRevision: 2,
        timeZone: "Europe/Berlin",
        organizationIds: [ORGANIZATION],
        storedCalendar: null,
      },
    ],
    bookings: [],
    userIds: [OWNER],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

const input = (rows: IdentitySourceRow[], cohort = true) => ({
  sourceRunId: "vay1351-0123456789abcdef01234567",
  snapshotAt: AT,
  completedAt: AT,
  rows,
  target: target(),
  cohort: cohort ? { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] } : null,
});

function snapshot(record: PmsTargetRecord): PmsInventoryDaySnapshot {
  const day = record.row;
  return {
    propertyId: String(day["propertyId"]),
    roomTypeId: String(day["roomTypeId"]),
    stayDate: String(day["stayDate"]),
    calendarRevision: Number(day["calendarRevision"]),
    inventoryRevision: Number(day["inventoryRevision"]),
    sourceRevisions: {
      generated: Number(day["generatedSourceRevision"]),
      channel: Number(day["channelSourceRevision"]),
      manual: Number(day["manualSourceRevision"]),
      block: Number(day["blockSourceRevision"]),
      booking: Number(day["bookingSourceRevision"]),
    },
    operatingStatus: day["status"] as "open" | "closed",
    physicalCapacityCount: Number(day["totalCount"]),
    generatedSellableLimitCount: Number(day["generatedSellableLimitCount"]),
    channelSellableLimitCount: day["channelSellableLimitCount"] as number | null,
    manualSellableLimitCount: day["manualSellableLimitCount"] as number | null,
    effectiveSellableLimitCount: Number(day["effectiveSellableLimitCount"]),
    assignedCount: Number(day["assignedCount"]),
    blockedCount: Number(day["blockedCount"]),
    linkedStopSell: day["linkedStopSell"] === true,
    linkedSourceRevision: Number(day["linkedSourceRevision"]),
    availableCount: Number(day["availableCount"]),
  };
}

function migrated(rows: IdentitySourceRow[]) {
  const plan = buildProductionPmsPlan(input(rows));
  expect(plan.blockers).toEqual([]);
  const context = createProductionPmsContext(input(rows));
  const [calendar] = planPmsCohortCalendars(context, buildPmsRoomRecords(context));
  const days = plan.records.filter((record) => record.targetTable === "inventory_days");
  return { plan, calendar: calendar!.configuration, days };
}

describe("production PMS cohort inventory coverage", () => {
  it("writes canonical days the native materializer adopts unchanged", () => {
    const { plan, calendar, days } = migrated(sourceRows());
    const stayDates = days.map((day) => String(day.row["stayDate"])).sort();
    const coverage = plan.records.find(
      (record) => record.targetTable === "inventory_materialization_coverage",
    )!.row;
    expect(coverage).toMatchObject({
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      calendarRevision: 1,
      materializedRevision: 1,
      coverageFrom: stayDates[0],
      coverageThrough: stayDates.at(-1),
      roomTypeCount: 1,
      expectedDayCount: 366,
      materializedDayCount: 366,
    });
    const native = planPmsInventoryMaterialization({
      propertyId: PROPERTY,
      configurationSource: calendar.source,
      configuration: calendar,
      horizon: { from: stayDates[0]!, through: stayDates.at(-1)! },
      currentDays: days.map(snapshot),
    });
    expect(native).toMatchObject({ ok: true, outcome: "unchanged", changedDays: [] });
  });

  it("keeps closed seasons by schedule and other closed dates as manual limits", () => {
    // Priced at 0 on Christmas Eve: a legacy stop-sell that only a manual limit can keep.
    const { calendar, days } = migrated(sourceRows({}, { daily_rates: { "2026-12-24": 0 } }));
    const day = (date: string) => days.find((record) => record.row["stayDate"] === date)!.row;
    expect(day("2027-01-15")).toMatchObject({
      status: "closed",
      manualSellableLimitCount: null,
      availableCount: 0,
    });
    expect(day("2026-12-24")).toMatchObject({
      status: "open",
      manualSellableLimitCount: 0,
      manualSourceRevision: 1,
      effectiveSellableLimitCount: 0,
      availableCount: 0,
    });
    expect(day("2026-11-01")).toMatchObject({
      manualSellableLimitCount: null,
      blockedCount: 1,
      blockSourceRevision: 1,
      availableCount: 1,
    });
    // The VAY-2066 job rewrites generated counts (0 without a pms-pricing.v1 plan, else the
    // binding) and extends the horizon: closed days stay closed, also next year.
    const extend = (count: number | null) => {
      const extended = planPmsInventoryMaterialization({
        propertyId: PROPERTY,
        configurationSource: calendar.source,
        configuration: calendar,
        horizon: { from: "2027-06-01", through: "2028-05-31" },
        currentDays: days.map(snapshot).filter((record) => record.stayDate >= "2027-06-01"),
        generatedSellableLimitOverrides:
          count === null ? [] : [{ roomTypeId: ROOM_TYPE, stayDate: "2027-07-01", count }],
      });
      if (!extended.ok) throw new Error(extended.error.code);
      const available = (date: string) =>
        extended.days.find((record) => record.stayDate === date)?.availableCount;
      return [available("2028-01-15"), available("2027-07-01")];
    };
    expect(extend(null)).toEqual([0, 2]);
    expect(extend(0)).toEqual([0, 0]);
    const rewritten = planPmsInventoryMaterialization({
      propertyId: PROPERTY,
      configurationSource: calendar.source,
      configuration: calendar,
      horizon: { from: "2026-10-09", through: "2027-10-09" },
      currentDays: days.map(snapshot),
      generatedSellableLimitOverrides: [
        { roomTypeId: ROOM_TYPE, stayDate: "2026-12-24", count: 2 },
      ],
    });
    if (!rewritten.ok) throw new Error(rewritten.error.code);
    expect(rewritten.days.find((record) => record.stayDate === "2026-12-24")?.availableCount).toBe(
      0,
    );
  });

  it("covers a fixed auto-open window to its month end, and a rolling one for a year", () => {
    const last = (hotel: Record<string, unknown>) =>
      String(migrated(sourceRows(hotel, { operating_periods: [] })).days.at(-1)!.row["stayDate"]);
    const rolling = { calendar_auto_open_enabled: true, calendar_auto_open_through: "2027-01-31" };
    expect(last(rolling)).toBe("2027-10-09");
    expect(
      last({
        ...rolling,
        calendar_auto_open_mode: "fixed",
        calendar_auto_open_fixed_month: "2027-01-15",
      }),
    ).toBe("2027-01-31");
  });

  it("extends coverage through the last legacy booking or block and skips unbound types", () => {
    const rows = sourceRows({}, { operating_periods: [] });
    rows.push(
      row("room_blocks", {
        id: "70000000-0000-4000-a000-000000000002",
        hotel_id: HOTEL,
        room_type_id: ROOM_TYPE,
        start_date: "2027-11-01",
        end_date: "2027-11-05",
        blocked_count: 1,
        reason: "renovation",
      }),
      row("room_types", {
        id: "30000000-0000-4000-a000-000000000002",
        hotel_id: HOTEL,
        name: "Retired",
        total_rooms: 0,
        base_rate: "100",
        currency: "EUR",
        is_active: false,
      }),
    );
    const { plan, days } = migrated(rows);
    expect(days.at(-1)!.row).toMatchObject({ stayDate: "2027-11-04", blockedCount: 1 });
    expect(days.every((record) => record.row["roomTypeId"] === ROOM_TYPE)).toBe(true);
    expect(plan.parity.expectedInventoryDaysByRoomType).toEqual({ [ROOM_TYPE]: days.length });
    expect(
      plan.records.find((record) => record.targetTable === "inventory_materialization_coverage")
        ?.row,
    ).toMatchObject({ coverageThrough: "2027-11-04", expectedDayCount: days.length });
  });

  it("closes days legacy does not sell as manual limits: past its window, and leap days", () => {
    const block = row("room_blocks", {
      id: "70000000-0000-4000-a000-000000000002",
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      start_date: "2027-11-01",
      end_date: "2027-11-05",
      blocked_count: 1,
      reason: "renovation",
    });
    const manual = (hotel: Record<string, unknown>) =>
      migrated([...sourceRows(hotel, { operating_periods: [] }), block]).days.find(
        (record) => record.row["stayDate"] === "2027-10-20",
      )!.row["manualSellableLimitCount"];
    // 2027-10-20 is only covered for the block: legacy sells it only within its window.
    const rolling = { calendar_auto_open_enabled: true, calendar_auto_open_through: "2027-01-31" };
    expect(manual(rolling)).toBe(0);
    expect(manual({ ...rolling, calendar_auto_open_through: "2027-12-31" })).toBeNull();
    expect(manual({})).toBeNull();
    expect(
      manual({
        ...rolling,
        calendar_auto_open_mode: "fixed",
        calendar_auto_open_fixed_month: "2027-01-15",
      }),
    ).toBe(0);

    // Year-round as a recurring schedule, but legacy never opens 29 February.
    const rows = sourceRows(
      {},
      {
        operating_periods: [
          { from: "01-01", to: "02-28" },
          { from: "03-01", to: "12-31" },
        ],
      },
    ).filter((source) => source.sourceTable !== "room_blocks");
    const at = "2027-10-09T08:00:00.000Z";
    const plan = buildProductionPmsPlan({ ...input(rows), snapshotAt: at, completedAt: at });
    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.find((record) => record.row["stayDate"] === "2028-02-29")?.row,
    ).toMatchObject({ status: "open", manualSellableLimitCount: 0, availableCount: 0 });
  });

  it("plans no calendar whose inventory the native jobs could not carry", () => {
    const retired = "30000000-0000-4000-a000-000000000002";
    const base = [
      ...sourceRows({}, { operating_periods: [] }),
      row("room_types", {
        id: retired,
        hotel_id: HOTEL,
        name: "Retired",
        total_rooms: 1,
        base_rate: "100",
        currency: "EUR",
        is_active: false,
      }),
    ];
    const consumer = (table: string, roomTypeId: string, values: Record<string, unknown>) =>
      row(table, {
        id: "80000000-0000-4000-a000-000000000001",
        hotel_id: HOTEL,
        room_type_id: roomTypeId,
        number_of_rooms: 1,
        created_at: AT,
        ...values,
      });
    const horizons = (rows: IdentitySourceRow[], stored: Record<string, string> | null = null) => {
      const context = createProductionPmsContext({
        ...input(rows),
        target: {
          ...target(),
          cohortProperties: [
            { ...target().cohortProperties![0]!, inventoryThroughByRoomType: stored },
          ],
        },
      });
      const calendars = planPmsCohortCalendars(context, buildPmsRoomRecords(context));
      expect(calendars).toHaveLength(1);
      return { context, calendars, carried: withCohortInventoryHorizons(context, calendars) };
    };
    const booking = (status: string, roomTypeId = retired) =>
      consumer("bookings", roomTypeId, {
        status,
        payment_status: "paid",
        check_in: "2027-12-10",
        check_out: "2027-12-12",
      });
    expect(horizons(base).carried).toHaveLength(1);
    // The unbound room type still holds a booking, or stored days, in the coverage.
    expect(horizons([...base, booking("confirmed")]).carried).toEqual([]);
    expect(horizons([...base, booking("cancelled")]).carried).toHaveLength(1);
    expect(horizons(base, { [retired]: "2027-10-01" }).carried).toEqual([]);
    expect(horizons(base, { [retired]: "2026-10-08" }).carried).toHaveLength(1);
    // A live booking extends the bound type's coverage; a cancelled one does not.
    const extended = horizons([...base, booking("confirmed", ROOM_TYPE)]);
    expect(cohortInventoryHorizon(extended.context, extended.calendars[0]!).through).toBe(
      "2027-12-11",
    );
    // Past the auto-open worker's 762-day maximum: through 2028-11-19 is 773 days.
    const far = consumer("room_blocks", ROOM_TYPE, {
      start_date: "2028-11-10",
      end_date: "2028-11-20",
      blocked_count: 1,
    });
    expect(horizons([...base, far]).carried).toEqual([]);
    expect(
      buildProductionPmsPlan(input([...base, far])).records.map((r) => r.targetTable),
    ).not.toContain("operating_calendar_revisions");
    // A stored calendar blocks instead of being dropped.
    const stored = horizons([...base, far]);
    stored.context.target.cohortProperties![0]!.storedCalendar = {} as never;
    expect(withCohortInventoryHorizons(stored.context, stored.calendars)).toEqual([]);
    expect(stored.context.blockers).toContainEqual(
      expect.objectContaining({ code: "COHORT_INVENTORY_NOT_CARRIED", sourceId: HOTEL }),
    );
  });

  it("blocks a live draft past the year only for a calendared hotel", () => {
    const draft = row("booking_drafts", {
      id: "90000000-0000-4000-a000-000000000001",
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      check_in: "2027-12-01",
      check_out: "2027-12-03",
      number_of_rooms: 1,
      expires_at: "2026-10-10T00:00:00.000Z",
      materialized_booking_id: null,
    });
    const codes = (cohort: boolean) =>
      buildProductionPmsPlan(input([...sourceRows(), draft], cohort)).blockers.map(
        (blocker) => blocker.code,
      );
    expect(codes(true)).toContain("ACTIVE_BOOKING_DRAFT");
    expect(codes(false)).not.toContain("ACTIVE_BOOKING_DRAFT");
  });

  it("counts the horizon in the calendar's time zone", () => {
    // 22:00 UTC on 8 October is already 9 October in Berlin, while legacy has no time zone.
    const rows = sourceRows({ timezone: null }, { operating_periods: [] });
    const plan = buildProductionPmsPlan({ ...input(rows), snapshotAt: "2026-10-08T22:00:00.000Z" });
    expect(
      plan.records.find((record) => record.targetTable === "inventory_materialization_coverage")
        ?.row,
    ).toMatchObject({ coverageFrom: "2026-10-09", coverageThrough: "2027-10-09" });
  });

  it("keeps the legacy inventory shape without a cohort", () => {
    const plan = buildProductionPmsPlan(input(sourceRows(), false));
    const days = plan.records.filter((record) => record.targetTable === "inventory_days");
    expect(days.every((record) => record.row["calendarRevision"] === null)).toBe(true);
    expect(plan.records.some((record) => /coverage/.test(record.targetTable))).toBe(false);
  });
});
