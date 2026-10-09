import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { NATIVE_PRICING_CURRENCIES } from "./productionPmsCohortSetup.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import { PRODUCTION_PMS_TABLES } from "./productionPmsTables.js";
import type { ExistingPmsTargetRecord, ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const ROOM_TYPE = "30000000-0000-4000-a000-00000000000";
const ROOM = "40000000-0000-4000-a000-0000000000";
const AT = "2026-10-09T00:00:00.000Z";
const LATER = "2026-10-10T00:00:00.000Z";
const API = join(import.meta.dirname, "../../../apps/api/src");

const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
  sourceDatabase: "pms",
  sourceTable,
  rowOrdinal: 1,
  data: { created_at: AT, updated_at: AT, ...data },
});
const hotel = (index: number) => row("hotels", { id: `${HOTEL}${index}`, timezone: "UTC" });
const roomType = (index: number, hotelIndex: number, extra: Record<string, unknown> = {}) =>
  row("room_types", {
    id: `${ROOM_TYPE}${index}`,
    hotel_id: `${HOTEL}${hotelIndex}`,
    name: `Room ${index}`,
    total_rooms: 0,
    base_rate: "0",
    currency: "EUR",
    ...extra,
  });
const room = (index: number, typeIndex: number, hotelIndex: number, number: string) =>
  row("rooms", {
    id: `${ROOM}${String(index).padStart(2, "0")}`,
    hotel_id: `${HOTEL}${hotelIndex}`,
    room_type_id: `${ROOM_TYPE}${typeIndex}`,
    room_number: number,
  });

function target(count: number, records: ExistingPmsTargetRecord[] = []): ProductionPmsTargetState {
  return {
    propertyLinks: Array.from({ length: count }, (_, index) => ({
      sourceId: `${HOTEL}${index + 1}`,
      propertyId: `${PROPERTY}${index + 1}`,
      relationship: "operational_input",
      status: "active",
      migrationRunId: "run",
      migrationDisposition: index === 2 ? ("private_quarantine" as const) : ("canonical" as const),
      ownerStatus: "active",
    })),
    bookings: [],
    userIds: [],
    mediaIds: [],
    records,
    provenance: [],
  };
}

const plan = (
  rows: IdentitySourceRow[],
  pmsHotelIds: string[] | null,
  state = target(4),
  completedAt = AT,
) =>
  buildProductionPmsPlan({
    sourceRunId: "run",
    snapshotAt: AT,
    completedAt,
    rows,
    target: state,
    cohort: pmsHotelIds && { bookingHotelIds: [], pmsHotelIds, marketplaceHotelIds: [] },
  });
const rows = (plan: ReturnType<typeof buildProductionPmsPlan>, table: string) =>
  plan.records.filter((record) => record.targetTable === table).map((record) => record.row);
const settings = (index: number, currency: string, revision = 1, updatedAt = AT) => ({
  propertyId: `${PROPERTY}${index}`,
  currency,
  pricingCurrencyRevision: revision,
  createdAt: AT,
  updatedAt,
});

describe("production PMS cohort pricing settings and room labels", () => {
  // Hotels: 1 cohort, 2 outside the cohort, 3 cohort in private quarantine, 4 cohort.
  const source = [
    ...[1, 2, 3, 4].map(hotel),
    roomType(1, 1),
    roomType(2, 1, { is_active: false, currency: "USD" }),
    roomType(3, 2),
    roomType(4, 3),
    roomType(5, 4, { is_active: false, currency: "CHF" }),
    room(1, 1, 1, "101"),
    room(2, 1, 1, "1a"),
    room(3, 1, 1, "1A"), // the case-insensitive twin keeps both unverified
    room(4, 2, 1, "201"), // retired with its inactive room type
    room(5, 3, 2, "101"),
    room(6, 4, 3, "101"),
  ];
  const cohort = [`${HOTEL}1`, `${HOTEL}3`, `${HOTEL}4`];

  it("writes native pricing settings and verified labels for carried cohort hotels only", () => {
    const result = plan(source, cohort);
    expect(result.blockers).toEqual([]);
    // Hotel 1 takes its operating room type's currency; hotel 4 has none operating, so all.
    expect(rows(result, "property_pricing_settings")).toEqual([
      settings(1, "EUR"),
      settings(4, "CHF"),
    ]);
    expect(
      Object.fromEntries(
        rows(result, "rooms").map((value) => [value["id"], value["operationalLabelStatus"]]),
      ),
    ).toEqual({
      [`${ROOM}01`]: "verified",
      [`${ROOM}02`]: "unverified",
      [`${ROOM}03`]: "unverified",
      [`${ROOM}04`]: "unverified",
      [`${ROOM}05`]: "unverified",
      [`${ROOM}06`]: "unverified",
    });
  });

  it("writes no row for an ambiguous or unsupported currency", () => {
    const ambiguous = [hotel(1), roomType(1, 1), roomType(2, 1, { currency: "USD" })];
    expect(rows(plan(ambiguous, [`${HOTEL}1`]), "property_pricing_settings")).toEqual([]);
    const unsupported = [hotel(1), roomType(1, 1, { currency: "ISK" })];
    expect(rows(plan(unsupported, [`${HOTEL}1`]), "property_pricing_settings")).toEqual([]);
  });

  it("changes nothing without a cohort, so the no-cohort plan is unchanged", () => {
    const result = plan(source, null);
    expect(rows(result, "property_pricing_settings")).toEqual([]);
    expect(rows(result, "rooms").every((value) => !("operationalLabelStatus" in value))).toBe(true);
  });

  it("keeps an unchanged currency and revises a changed one as the native writer", () => {
    const existing = (currency: string): ExistingPmsTargetRecord => ({
      targetProduct: "pms",
      targetTable: "property_pricing_settings",
      targetId: `${PROPERTY}1`,
      updatedAt: AT,
      row: settings(1, currency),
    });
    const unchanged = plan([hotel(1), roomType(1, 1)], [`${HOTEL}1`], target(1, [existing("EUR")]));
    expect(rows(unchanged, "property_pricing_settings")).toEqual([settings(1, "EUR")]);
    const changed = plan(
      [hotel(1), roomType(1, 1)],
      [`${HOTEL}1`],
      target(1, [existing("USD")]),
      LATER,
    );
    expect(rows(changed, "property_pricing_settings")).toEqual([settings(1, "EUR", 2, LATER)]);
  });

  it("mirrors the native first-currency insert, room label writer and currency list", async () => {
    const pricing = await readFile(join(API, "domains/pmsPricingCommandRepository.ts"), "utf8");
    const insert =
      /INSERT INTO pms\.property_pricing_settings \(\s*([^)]*)\)\s*VALUES \(([^)]*)\)/.exec(
        pricing,
      );
    expect(insert?.[1]?.split(",").map((column) => column.trim())).toEqual(
      PRODUCTION_PMS_TABLES["property_pricing_settings"]!.columns.map(([, sql]) => sql),
    );
    // Revision 1 and one timestamp for both times; the planner writes the same.
    expect(insert?.[2]?.replace(/\s+/g, " ")).toBe(
      "$1::uuid, $2, 1, $3::timestamptz, $3::timestamptz",
    );

    const rooms = await readFile(
      join(API, "domains/pmsPhysicalRoomManagementRepository.ts"),
      "utf8",
    );
    expect(rooms).toMatch(/room_number, operational_label_status,[^]*?\$3,'verified'/);

    const capabilities = await readFile(
      join(API, "domains/pmsPricingCurrencyCapabilities.ts"),
      "utf8",
    );
    const native = /CODE_STRINGS_V1 = \[([^\]]*)\]/.exec(capabilities)?.[1]?.match(/[A-Z]{3}/g);
    expect(native?.sort()).toEqual([...NATIVE_PRICING_CURRENCIES].sort());
  });
});
