import { describe, expect, it } from "vitest";
import { planPmsInventoryMaterialization, type PmsInventoryDaySnapshot } from "@vayada/domain-pms";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planPmsCohortCalendars } from "./productionPmsCohortCalendarRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
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

  it("keeps legacy closed dates as manual limits through the auto-open rate gate", () => {
    const { calendar, days } = migrated(sourceRows());
    const day = (date: string) => days.find((record) => record.row["stayDate"] === date)!.row;
    expect(day("2027-01-15")).toMatchObject({
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
    // binding): a legacy closed date stays closed either way.
    const stayDates = days.map((record) => String(record.row["stayDate"])).sort();
    for (const count of [0, 2]) {
      const rewritten = planPmsInventoryMaterialization({
        propertyId: PROPERTY,
        configurationSource: calendar.source,
        configuration: calendar,
        horizon: { from: stayDates[0]!, through: stayDates.at(-1)! },
        currentDays: days.map(snapshot),
        generatedSellableLimitOverrides: stayDates.map((stayDate) => ({
          roomTypeId: ROOM_TYPE,
          stayDate,
          count,
        })),
      });
      if (!rewritten.ok) throw new Error(rewritten.error.code);
      expect(
        rewritten.days.find((record) => record.stayDate === "2027-01-15")?.availableCount,
      ).toBe(0);
    }
  });

  it("does not treat a rolling auto-open window as a closed date, but does a fixed one", () => {
    const rolling = { calendar_auto_open_enabled: true, calendar_auto_open_through: "2027-01-31" };
    const last = (rows: IdentitySourceRow[]) =>
      migrated(rows).days.find((record) => record.row["stayDate"] === "2027-10-01")!.row;
    expect(last(sourceRows(rolling, { operating_periods: [] }))).toMatchObject({
      manualSellableLimitCount: null,
    });
    const fixed = {
      ...rolling,
      calendar_auto_open_mode: "fixed",
      calendar_auto_open_fixed_month: "2027-01-15",
    };
    expect(last(sourceRows(fixed, { operating_periods: [] }))).toMatchObject({
      manualSellableLimitCount: 0,
    });
  });

  it("keeps the legacy inventory shape without a cohort", () => {
    const plan = buildProductionPmsPlan(input(sourceRows(), false));
    const days = plan.records.filter((record) => record.targetTable === "inventory_days");
    expect(days.every((record) => record.row["calendarRevision"] === null)).toBe(true);
    expect(plan.records.some((record) => /coverage/.test(record.targetTable))).toBe(false);
  });
});
