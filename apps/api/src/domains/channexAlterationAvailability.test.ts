import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertChannexAlterationAvailability } from "./channexAlterationAvailability.js";
import type { PmsOccupiedInventoryClient } from "./pmsOccupiedInventory.js";

function fixture() {
  const propertyId = randomUUID(),
    bookingId = randomUUID(),
    roomTypeId = randomUUID(),
    externalId = randomUUID();
  const input = {
    propertyId,
    bookingId,
    changes: {
      requestedCheckIn: "2026-10-01",
      requestedCheckOut: "2026-10-03",
      rooms: [{ roomTypeId: externalId }],
      channex: { connectionId: randomUUID() },
    },
  };
  const mapping = { externalId, roomTypeId, linked: false };
  const booking = { checkIn: "2026-10-01", checkOut: "2026-10-03", roomCount: 1 };
  const assignment = {
    roomTypeId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    source: "channel",
    evidence: "exact",
    linked: false,
  };
  const day = {
    roomTypeId,
    stayDate: "2026-10-01",
    totalCount: 1 as unknown,
    effectiveSellableLimitCount: 1,
    assignedCount: 1,
    expectedAssignedCount: 1,
    blockedCount: 0,
    status: "open",
    linkedStopSell: false,
  };
  const rows = {
    mappings: [mapping],
    booking: [booking],
    assignments: [assignment],
    coverage: [{}, {}],
    days: [day, { ...day, stayDate: "2026-10-02" }],
  };
  const queries: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  const client = {
    query: async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM pms.channel_room_type_mappings")) return { rows: rows.mappings };
      if (sql.includes("FROM booking.guest_bookings WHERE")) return { rows: rows.booking };
      if (sql.includes("FROM pms.operational_booking_assignments assignment JOIN"))
        return { rows: rows.assignments };
      if (sql.includes("JOIN pms.inventory_materialization_coverage"))
        return { rows: rows.coverage };
      if (sql.includes("WITH target_days")) return { rows: rows.days };
      throw new Error("Unexpected SQL");
    },
  } as PmsOccupiedInventoryClient;
  return { input, rows, client, queries };
}

describe("Airbnb alteration availability", () => {
  it("credits only the booking's own overlapping rooms without writing inventory", async () => {
    const f = fixture();
    await assertChannexAlterationAvailability(f.client, f.input);
    expect(f.queries.every(({ sql }) => !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(true);
  });
  it("does not credit the original room on an added sold-out night", async () => {
    const f = fixture();
    f.input.changes.requestedCheckOut = "2026-10-04";
    f.rows.coverage.push({});
    f.rows.days.push({ ...f.rows.days[0]!, stayDate: "2026-10-03" });
    await expect(assertChannexAlterationAvailability(f.client, f.input)).rejects.toThrow(
      "alteration_rooms_unavailable",
    );
  });
  it("does not credit an old room type when switching types", async () => {
    const f = fixture();
    f.rows.assignments[0]!.roomTypeId = randomUUID();
    await expect(assertChannexAlterationAvailability(f.client, f.input)).rejects.toThrow(
      "alteration_rooms_unavailable",
    );
  });
  it("counts repeated requested room types as multiple rooms", async () => {
    const f = fixture();
    f.input.changes.rooms.push({ ...f.input.changes.rooms[0]! });
    await expect(assertChannexAlterationAvailability(f.client, f.input)).rejects.toThrow(
      "alteration_rooms_unavailable",
    );
  });
  it.each([
    "mapping",
    "coverage",
    "assignment",
    "evidence",
    "stale occupancy",
    "null count",
    "linked target",
    "linked original",
    "closed",
    "blocked",
    "limit",
  ])("rejects %s", async (kind) => {
    const f = fixture();
    if (kind === "mapping") f.rows.mappings = [];
    if (kind === "coverage") f.rows.coverage.pop();
    if (kind === "assignment") f.rows.assignments = [];
    if (kind === "evidence") f.rows.assignments[0]!.evidence = "unknown";
    if (kind === "stale occupancy") f.rows.days[0]!.expectedAssignedCount = 2;
    if (kind === "null count") f.rows.days[0]!.totalCount = null;
    if (kind === "linked target") f.rows.mappings[0]!.linked = true;
    if (kind === "linked original") f.rows.assignments[0]!.linked = true;
    if (kind === "closed") f.rows.days[0]!.status = "closed";
    if (kind === "blocked") f.rows.days[0]!.blockedCount = 1;
    if (kind === "limit") f.rows.days[0]!.effectiveSellableLimitCount = 0;
    await expect(assertChannexAlterationAvailability(f.client, f.input)).rejects.toThrow();
  });
  it("allows enough remaining capacity for multiple requested rooms", async () => {
    const f = fixture();
    f.input.changes.rooms.push({ ...f.input.changes.rooms[0]! });
    for (const day of f.rows.days) {
      day.totalCount = 3;
      day.effectiveSellableLimitCount = 3;
    }
    await expect(assertChannexAlterationAvailability(f.client, f.input)).resolves.toBeUndefined();
  });
  it("compiles every query against the migrated PostgreSQL schema", async (context) => {
    const url = process.env["TEST_DATABASE_URL"];
    if (!url) {
      context.skip();
      return;
    }
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
      throw new Error("Refusing non-test database");
    const f = fixture();
    await assertChannexAlterationAvailability(f.client, f.input);
    const pool = new pg.Pool({ connectionString: url });
    try {
      for (const { sql, values } of f.queries)
        await pool.query(`EXPLAIN ${sql}`, values ? [...values] : []);
    } finally {
      await pool.end();
    }
  });
});
