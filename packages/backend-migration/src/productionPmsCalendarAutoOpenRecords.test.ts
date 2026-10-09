import { describe, expect, it } from "vitest";

import { buildPmsCalendarAutoOpenRecords } from "./productionPmsCalendarAutoOpenRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const AT = "2026-10-09T00:00:00.000Z";
const cohort = (...indexes: number[]) => ({
  bookingHotelIds: [],
  pmsHotelIds: indexes.map((index) => `${HOTEL}${index}`),
  marketplaceHotelIds: [],
});

function hotel(index: number, settings: Record<string, unknown>): IdentitySourceRow {
  return {
    sourceDatabase: "pms",
    sourceTable: "hotels",
    rowOrdinal: index,
    data: { id: `${HOTEL}${index}`, timezone: "Europe/Berlin", ...settings },
  };
}

function target(count: number, overrides: Partial<ProductionPmsTargetState> = {}) {
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
    bookings: [],
    userIds: [],
    mediaIds: [],
    records: [],
    provenance: [],
    ...overrides,
  } satisfies ProductionPmsTargetState;
}

function build(rows: IdentitySourceRow[], scope = cohort(1, 2, 3, 4, 5), state = target(5)) {
  const context = createProductionPmsContext({
    sourceRunId: "run",
    snapshotAt: AT,
    completedAt: AT,
    rows,
    target: state,
    cohort: scope,
  });
  return { records: buildPmsCalendarAutoOpenRecords(context), blockers: context.blockers };
}

const enabled = { calendar_auto_open_enabled: true, calendar_auto_open_mode: "rolling" };
const fixed = { calendar_auto_open_mode: "fixed" };
type Setting = [enabled: boolean, mode: string, months: number | null, fixed: string | null];
const setting = (index: number, ...[enabled, mode, rollingMonths, fixedEndMonth]: Setting) => ({
  propertyId: `${PROPERTY}${index}`,
  revision: 1,
  enabled,
  mode,
  rollingMonths,
  fixedEndMonth,
  updatedAt: AT,
});

describe("production PMS calendar auto-open settings", () => {
  it("carries enabled cohort choices and writes inert hotels an explicit disabled row", () => {
    const state = target(7);
    state.propertyLinks[3]!.migrationDisposition = "private_quarantine";
    state.propertyLinks.splice(5, 1); // hotel 6 stays unresolved
    const { records, blockers } = build(
      [
        hotel(1, { ...enabled, calendar_auto_open_months: 24, calendar_auto_open_through: "x" }),
        // Mid-month in the last month the native writer accepts.
        hotel(2, { ...enabled, ...fixed, calendar_auto_open_fixed_month: "2028-10-15" }),
        hotel(3, { ...fixed, calendar_auto_open_enabled: false }), // legacy off: on by default
        hotel(4, { ...enabled, calendar_auto_open_months: 12 }), // private quarantine
        hotel(5, { ...enabled, ...fixed }), // outside the cohort
        hotel(7, { calendar_auto_open_enabled: null }), // legacy empty: on by default
        hotel(6, enabled), // unresolved: source coverage reports it
      ],
      cohort(1, 2, 3, 4, 6, 7),
      state,
    );

    expect(blockers).toEqual([]);
    expect(records.map((record) => record.row)).toEqual([
      setting(1, true, "rolling", 24, null),
      setting(2, true, "fixed", null, "2028-10-01"),
      setting(4, false, "rolling", 12, null),
      // A disabled fixed mode without a month cannot be stored, so it stays rolling.
      setting(5, false, "rolling", 18, null),
    ]);
    expect(records[0]).toMatchObject({ sourceTable: "hotels", sourceId: `${HOTEL}1` });
  });

  it("writes nothing without a cohort, so the no-cohort plan is unchanged", () => {
    expect(build([hotel(1, enabled)], null as never).records).toEqual([]);
    const plan = buildProductionPmsPlan({
      sourceRunId: "run",
      snapshotAt: AT,
      completedAt: AT,
      rows: [hotel(1, enabled)],
      target: target(1),
    });
    expect(plan.records).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it.each([
    ["an enabled fixed mode without a month", fixed, "needs a target month"],
    [
      "a fixed month past the native 24-month maximum",
      { ...fixed, calendar_auto_open_fixed_month: "2028-11-01" },
      "24-month maximum",
    ],
    ["an unsupported horizon", { calendar_auto_open_months: 6 }, "must be 12, 18 or 24"],
    ["an unknown mode", { calendar_auto_open_mode: "weekly" }, "rolling or fixed"],
  ])("blocks %s", (_case, settings, message) => {
    const { records, blockers } = build([hotel(1, { ...enabled, ...settings })]);
    expect(records).toEqual([]);
    expect(blockers).toEqual([
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "pms.hotels",
        message: expect.stringContaining(message),
      }),
    ]);
  });

  describe("reconciliation with the target row", () => {
    const [LATER, NEWER] = ["2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"];
    const twelve = { calendar_auto_open_months: 12 };
    const plan = (
      settings: Record<string, unknown>,
      row: Record<string, unknown>,
      updatedAt: string,
      prior: boolean,
      firstScope = cohort(1),
    ) => {
      const first = build([hotel(1, enabled)], firstScope, target(1)).records[0]!;
      return buildProductionPmsPlan({
        sourceRunId: "run",
        snapshotAt: LATER,
        completedAt: LATER,
        rows: [hotel(1, { ...enabled, ...settings })],
        target: target(1, {
          records: [
            {
              targetProduct: "pms",
              targetTable: "calendar_auto_open_settings",
              targetId: `${PROPERTY}1`,
              updatedAt,
              row: { ...first.row, ...row, updatedAt },
            },
          ],
          provenance: prior ? [{ ...first, lastMigratedAt: AT }] : [],
        }),
        cohort: cohort(1),
      });
    };

    it("keeps an unchanged setting, revision and time on a later run", () => {
      const result = plan({}, {}, AT, true);
      expect(result.blockers).toEqual([]);
      expect(result.writes).toEqual([]);
      expect(result.records[0]!.row).toMatchObject({ revision: 1, updatedAt: AT });
    });

    it("advances the revision when the legacy setting changed", () => {
      const result = plan(twelve, {}, AT, true);
      expect(result.writes.map((record) => record.row)).toEqual([
        expect.objectContaining({ revision: 2, rollingMonths: 12, updatedAt: LATER }),
      ]);
    });

    it("enables a hotel that joins the cohort after an earlier run kept it disabled", () => {
      const result = plan({}, {}, AT, true, cohort());
      expect(result.blockers).toEqual([]);
      expect(result.writes.map((record) => record.row)).toEqual([
        expect.objectContaining({ revision: 2, enabled: true, updatedAt: LATER }),
      ]);
    });

    it("blocks a newer conflicting row without migration provenance", () => {
      const result = plan({}, { revision: 3, rollingMonths: 24 }, NEWER, false);
      expect(result.writes).toEqual([]);
      expect(result.blockers).toEqual([
        expect.objectContaining({ code: "TARGET_NEWER_WITHOUT_PROVENANCE", source: "pms.hotels" }),
      ]);
    });
  });
});
