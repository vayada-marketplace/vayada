import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import { PRODUCTION_PMS_TABLES } from "./productionPmsTables.js";
import type { PmsCohortPropertyState, ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const ROOM_TYPE = "30000000-0000-4000-a000-00000000000";
const ROOM = "40000000-0000-4000-a000-0000000000";
const OWNER = "50000000-0000-4000-a000-000000000001";
const ORGANIZATION = "60000000-0000-4000-a000-000000000001";
const AT = "2026-10-09T00:00:00.000Z";

const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
  sourceDatabase: "pms",
  sourceTable,
  rowOrdinal: 1,
  data: { created_at: AT, updated_at: AT, ...data },
});
const hotel = (index: number) =>
  row("hotels", { id: `${HOTEL}${index}`, timezone: "Europe/Berlin", user_id: OWNER });
const roomType = (index: number, hotelIndex: number, rooms: number, extra = {}) =>
  row("room_types", {
    id: `${ROOM_TYPE}${index}`,
    hotel_id: `${HOTEL}${hotelIndex}`,
    name: `Room ${index}`,
    total_rooms: rooms,
    base_rate: "100",
    currency: "EUR",
    bed_type: "1 Double Bed",
    ...extra,
  });
let roomIndex = 0;
const rooms = (typeIndex: number, hotelIndex: number, count: number) =>
  Array.from({ length: count }, () => {
    roomIndex += 1;
    return row("rooms", {
      id: `${ROOM}${String(roomIndex).padStart(2, "0")}`,
      hotel_id: `${HOTEL}${hotelIndex}`,
      room_type_id: `${ROOM_TYPE}${typeIndex}`,
      room_number: `R${roomIndex}`,
    });
  });
const property = (index: number, values: Partial<PmsCohortPropertyState> = {}) => ({
  propertyId: `${PROPERTY}${index}`,
  profileRevision: 3,
  timeZone: "Europe/Berlin",
  organizationIds: [ORGANIZATION],
  storedCalendar: null,
  ...values,
});

function target(count: number, properties: PmsCohortPropertyState[]): ProductionPmsTargetState {
  return {
    propertyLinks: Array.from({ length: count }, (_, index) => ({
      sourceId: `${HOTEL}${index + 1}`,
      propertyId: `${PROPERTY}${index + 1}`,
      relationship: "operational_input",
      status: "active",
      migrationRunId: "run",
      migrationDisposition: "canonical" as const,
      ownerStatus: "active",
    })),
    cohortProperties: properties,
    bookings: [],
    userIds: [OWNER],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

const plan = (rows: IdentitySourceRow[], state: ProductionPmsTargetState, cohort = true) =>
  buildProductionPmsPlan({
    sourceRunId: "vay1351-0123456789abcdef01234567",
    snapshotAt: AT,
    completedAt: AT,
    rows,
    target: state,
    cohort: cohort
      ? { bookingHotelIds: [], pmsHotelIds: [`${HOTEL}1`], marketplaceHotelIds: [] }
      : null,
  });
const tables = (result: ReturnType<typeof plan>) =>
  result.records
    .filter((record) => /calendar|idempotency|domain_events|outbox|audit/.test(record.targetTable))
    .map((record) => record.targetTable)
    .sort();

describe("production PMS cohort operating calendar", () => {
  it("writes the native calendar save: revision, bindings and their platform rows", () => {
    const source = [hotel(1), roomType(1, 1, 2), ...rooms(1, 1, 2), roomType(2, 1, 1)];
    source.push(...rooms(2, 1, 1), roomType(3, 1, 0, { is_active: false }));
    const result = plan(source, target(1, [property(1)]));
    expect(result.blockers).toEqual([]);
    expect(tables(result)).toEqual([
      "domain_events",
      "idempotency_keys",
      "operating_calendar_revisions",
      "operating_calendar_room_bindings",
      "operating_calendar_room_bindings",
      "outbox_events",
      "product_audit_events",
    ]);
    const revision = result.records.find(
      (record) => record.targetTable === "operating_calendar_revisions",
    )!;
    expect(revision).toMatchObject({ targetId: `${PROPERTY}1:1`, mutable: false });
    expect(revision.row).toMatchObject({
      organizationId: ORGANIZATION,
      propertyId: `${PROPERTY}1`,
      calendarRevision: 1,
      contractVersion: "pms-operating-calendar.v1",
      propertyProfileRevision: 3,
      propertyTimeZone: "Europe/Berlin",
      scheduleMode: "year_round",
      recurringPeriodCount: 0,
      roomBindingCount: 2,
      defaultMinimumStayNights: 1,
      createdByUserId: OWNER,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(
      result.records
        .filter((record) => record.targetTable === "operating_calendar_room_bindings")
        .map((record) => record.row),
    ).toEqual(
      [1, 2].map((index) => ({
        propertyId: `${PROPERTY}1`,
        calendarRevision: 1,
        roomTypeId: `${ROOM_TYPE}${index}`,
        sourceRoomFactsRevision: 1,
        sourceRoomUnitsRevision: 1,
        physicalCapacityCount: 3 - index,
        startingSellableLimitCount: 3 - index,
      })),
    );
    const byTable = (table: string) =>
      result.records.find((record) => record.targetTable === table)!.row;
    expect(byTable("outbox_events")).toMatchObject({
      domainEventId: byTable("domain_events")["id"],
      destination: "pms.inventory-source",
      eventType: "pms.operating_calendar.changed",
    });
    expect(revision.row).toMatchObject({
      idempotencyKeyId: byTable("idempotency_keys")["id"],
      domainEventId: byTable("domain_events")["id"],
      outboxEventId: byTable("outbox_events")["id"],
    });
    expect(byTable("domain_events")).toMatchObject({ actorType: "migration", actorUserId: null });
    // Deterministic, so a rerun plans the same rows.
    expect(plan(source, target(1, [property(1)])).checksum).toBe(result.checksum);
  });

  it.each([
    ["no owner organization", property(1, { organizationIds: [] })],
    ["two owner organizations", property(1, { organizationIds: [ORGANIZATION, OWNER] })],
    ["no time zone", property(1, { timeZone: null })],
    ["an alias time zone the native registry refuses", property(1, { timeZone: "Asia/Calcutta" })],
  ])("writes no calendar for %s", (_, state) => {
    const result = plan([hotel(1), roomType(1, 1, 1), ...rooms(1, 1, 1)], target(1, [state]));
    expect([result.blockers, tables(result)]).toEqual([[], []]);
  });

  it.each([
    ["a room type without rooms", [roomType(1, 1, 0)]],
    ["an inventory total that differs from the rooms", [roomType(1, 1, 2), ...rooms(1, 1, 1)]],
    ["no operating room type", [roomType(1, 1, 1, { is_active: false }), ...rooms(1, 1, 1)]],
  ])("writes no calendar for %s", (_, typeRows) => {
    const result = plan([hotel(1), ...typeRows], target(1, [property(1)]));
    expect(tables(result)).toEqual([]);
  });

  it("writes nothing without a cohort, for an unknown owner, or outside the cohort", () => {
    const source = [hotel(1), roomType(1, 1, 1), ...rooms(1, 1, 1)];
    expect(tables(plan(source, target(1, [property(1)]), false))).toEqual([]);
    expect(tables(plan(source, { ...target(1, [property(1)]), userIds: [] }))).toEqual([]);
    // Hotel 2 is in the run but outside the cohort.
    const mixed = [...source, hotel(2), roomType(2, 2, 1), ...rooms(2, 2, 1)];
    const result = plan(mixed, target(2, [property(1), property(2)]));
    expect(
      result.records
        .filter((record) => record.targetTable === "operating_calendar_revisions")
        .map((record) => record.row["propertyId"]),
    ).toEqual([`${PROPERTY}1`]);
  });

  it("writes no calendar while an operating room type lacks native room facts", () => {
    const source = [hotel(1), roomType(1, 1, 1, { bed_type: "1 Futon" }), ...rooms(1, 1, 1)];
    expect(tables(plan(source, target(1, [property(1)])))).toEqual([]);
  });

  it("keeps a stored migrated calendar on a rerun and blocks a foreign one", () => {
    const source = [hotel(1), roomType(1, 1, 1), ...rooms(1, 1, 1)];
    const first = plan(source, target(1, [property(1)]));
    const revision = first.records.find(
      (record) => record.targetTable === "operating_calendar_revisions",
    )!.row;
    const stored = {
      idempotencyKeyId: String(revision["idempotencyKeyId"]),
      organizationId: ORGANIZATION,
      profileRevision: 3,
      timeZone: "Europe/Berlin",
      defaultMinimumStayNights: 1,
      createdByUserId: OWNER,
      createdAt: AT,
      bindings: [
        {
          roomTypeId: `${ROOM_TYPE}1`,
          sourceRoomFactsRevision: 1,
          sourceRoomUnitsRevision: 1,
          physicalCapacityCount: 1,
          startingSellableLimitCount: 1,
        },
      ],
    };
    // A later native profile edit (revision 4) and a new organization change nothing.
    const rerun = plan(
      source,
      target(1, [
        property(1, { profileRevision: 4, organizationIds: [OWNER], storedCalendar: stored }),
      ]),
    );
    expect(rerun.blockers).toEqual([]);
    expect(rerun.checksum).toBe(first.checksum);
    const foreign = plan(
      source,
      target(1, [property(1, { storedCalendar: { ...stored, idempotencyKeyId: OWNER } })]),
    );
    expect(foreign.blockers).toContainEqual(
      expect.objectContaining({ code: "COHORT_CALENDAR_CONFLICT" }),
    );
  });

  it("mirrors the native calendar insert columns and event keys", async () => {
    const native = await readFile(
      join(
        import.meta.dirname,
        "../../../apps/api/src/domains/pmsOperatingCalendarCommandRepository.ts",
      ),
      "utf8",
    );
    for (const table of ["operating_calendar_revisions", "operating_calendar_room_bindings"]) {
      const columns = new RegExp(`INSERT INTO pms\\.${table} \\(([^)]*)\\)`).exec(native)?.[1];
      expect(columns?.split(",").map((column) => column.trim())).toEqual(
        PRODUCTION_PMS_TABLES[table]!.columns.map(([, sql]) => sql),
      );
    }
    expect(native).toContain(
      "pms.operating-calendar.changed.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1",
    );
    expect(native).toContain(
      "`pms.operating-calendar.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`",
    );
    const registry = await readFile(
      join(
        import.meta.dirname,
        "../../../apps/api/src/domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.ts",
      ),
      "utf8",
    );
    expect(registry).toContain('"countries-and-timezones@3.9.0" as const');
    expect(registry).toContain("timezone.name === value && timezone.aliasOf === null");
  });
});
