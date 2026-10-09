import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FINANCIALS_DEFAULT_CATEGORIES } from "./financialsDefaultCategorySeed.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  OWNER_OFF_IMPORTED,
  pmsCohortModuleBlockers,
  samePmsCohortModule,
  type PlannedModuleActivation,
} from "./productionPmsCohortModules.js";
import { NATIVE_PRICING_CURRENCIES } from "./productionPmsCohortSetup.js";
import { runProductionPmsTransaction } from "./productionPmsMigration.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const ORGANIZATION = "60000000-0000-4000-a000-000000000001";
const AT = "2026-10-09T00:00:00.000Z";
const RUN = "vay1351-0123456789abcdef01234567";
const ROOT = join(import.meta.dirname, "../../..");

const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
  sourceDatabase: "pms",
  sourceTable,
  rowOrdinal: 1,
  data: { created_at: AT, updated_at: AT, ...data },
});
const legacy = (index: number, moduleId: string, active: unknown) =>
  row("property_module_activations", {
    hotel_id: `${HOTEL}${index}`,
    module_id: moduleId,
    is_active: active,
  });

/** Five carried cohort hotels; the fifth's organization lacks an active base entitlement. */
function plan(moduleActivations: IdentitySourceRow[], cohort = true) {
  const indexes = [1, 2, 3, 4, 5];
  const target: ProductionPmsTargetState = {
    propertyLinks: indexes.map((index) => ({
      sourceId: `${HOTEL}${index}`,
      propertyId: `${PROPERTY}${index}`,
      relationship: "operational_input",
      status: "active",
      migrationRunId: RUN,
      migrationDisposition: "canonical" as const,
      ownerStatus: "active",
    })),
    cohortProperties: indexes.map((index) => ({
      propertyId: `${PROPERTY}${index}`,
      profileRevision: 1,
      timeZone: "Europe/Berlin",
      organizationIds: [ORGANIZATION],
      pmsBaseOrganizationIds: index === 5 ? [] : [ORGANIZATION],
      storedCalendar: null,
    })),
    bookings: [],
    userIds: [],
    mediaIds: [],
    records: [],
    provenance: [],
  };
  return buildProductionPmsPlan({
    sourceRunId: RUN,
    snapshotAt: AT,
    completedAt: AT,
    rows: indexes.flatMap((index) => [
      row("hotels", { id: `${HOTEL}${index}` }),
      row("room_types", {
        id: `30000000-0000-4000-a000-00000000000${index}`,
        hotel_id: `${HOTEL}${index}`,
        name: "Room",
        total_rooms: 0,
        base_rate: "0",
        currency: "EUR",
      }),
    ]),
    target,
    cohort: cohort
      ? {
          bookingHotelIds: [],
          pmsHotelIds: indexes.map((index) => `${HOTEL}${index}`),
          marketplaceHotelIds: [],
        }
      : null,
    moduleActivations,
  });
}

const offModule: PlannedModuleActivation = {
  organizationId: ORGANIZATION,
  propertyId: `${PROPERTY}1`,
  entitlementKey: "module:financials",
  active: false,
  currency: "EUR",
  legacy: "off",
};
const offStored = {
  propertyId: `${PROPERTY}1`,
  status: "suspended",
  ready: true,
  ownerOff: true,
  unbounded: true,
  categories: 7,
};

describe("production PMS cohort module activations", () => {
  it("maps legacy financials on, off and absent, and reports modules the runtime lacks", () => {
    const result = plan([
      legacy(1, "financials", true),
      legacy(2, "financials", false),
      legacy(2, "affiliates", true),
      legacy(5, "financials", true), // no active base entitlement: no module
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.moduleActivations).toEqual(
      (
        [
          [1, true, "on"],
          [2, false, "off"],
          [3, false, "absent"],
          [4, false, "absent"],
        ] as const
      ).map(([index, active, state]) => ({
        organizationId: ORGANIZATION,
        propertyId: `${PROPERTY}${index}`,
        entitlementKey: "module:financials",
        active,
        currency: "EUR",
        legacy: state,
      })),
    );
    expect(result.unmappedModules).toEqual([`${HOTEL}2:affiliates`]);
    // An invalid legacy row blocks the run instead of aborting the plan.
    expect(plan([legacy(1, "financials", "yes")]).blockers).toEqual([
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "pms.property_module_activations",
      }),
    ]);
  });

  it("keeps a run without a cohort exactly as before", () => {
    const without = plan([], false);
    const withModules = plan([legacy(1, "financials", true)], false);
    expect(withModules).not.toHaveProperty("moduleActivations");
    expect(withModules.checksum).toBe(without.checksum);
    expect(plan([legacy(1, "financials", true)]).checksum).not.toBe(
      plan([legacy(1, "financials", false)]).checksum,
    );
  });

  it("blocks a stored module that differs, and keeps one that matches", () => {
    expect(samePmsCohortModule(offModule, offStored)).toBe(true);
    expect(pmsCohortModuleBlockers([offModule], [offStored])).toEqual([]);
    // Suspended without a live Owner-off marker is a suspension the Owner cannot undo.
    for (const stored of [
      { ...offStored, ownerOff: false },
      { ...offStored, status: "active", ownerOff: false },
      { ...offStored, categories: 6 },
      { ...offStored, ready: false },
    ])
      expect(pmsCohortModuleBlockers([offModule], [stored])).toEqual([
        expect.objectContaining({ code: "COHORT_MODULE_ACTIVATION_CONFLICT" }),
      ]);
    expect(pmsCohortModuleBlockers([offModule], [{ ...offStored, status: null }])).toEqual([]);
  });

  it("writes missing modules after verification, verifies them, and blocks conflicts", async () => {
    const run = async (stored: Array<Record<string, unknown>>) => {
      const steps: string[] = [];
      let reads = 0;
      const client = {
        async query(text: string) {
          if (text.includes("jsonb_to_recordset($1::jsonb)") && text.includes("ownerOff")) {
            reads += 1;
            steps.push(`read-modules:${reads}`);
            return { rows: reads === 1 ? stored : [offStored], rowCount: 1 };
          }
          if (text.includes("INSERT INTO identity.product_entitlements")) steps.push("module");
          return { rows: [], rowCount: 0 };
        },
      };
      let builds = 0;
      const report = await runProductionPmsTransaction(
        client as never,
        { sourceRunId: RUN, mode: "apply" },
        {
          readSnapshot: async () => ({ rows: [], snapshotAt: AT, completedAt: AT, cohort: null }),
          readPrerequisites: async () => ({
            propertyLinks: [],
            bookings: [],
            userIds: [],
            mediaIds: [],
          }),
          readTarget: async () => ({}) as never,
          buildPlan: () =>
            ({
              sourceRunId: RUN,
              checksum: "c".repeat(64),
              moduleActivations: [offModule],
              unmappedModules: [],
              records: [],
              writes: ++builds === 3 ? [] : [{ targetTable: "room_types" }],
              provenance: [],
              blockers: [],
              parity: {},
              counts: {},
            }) as never,
          writeRecords: async () => {
            steps.push("write");
            return { room_types: 1 };
          },
          writeProvenance: async () => 0,
          activateCohort: async () => {
            steps.push("activate");
            return {} as never;
          },
        },
      );
      return { report, steps };
    };
    const fresh = await run([{ ...offStored, status: null }]);
    expect(fresh.steps).toEqual(["read-modules:1", "write", "module", "read-modules:2"]);
    expect(fresh.report).toMatchObject({
      applied: true,
      modules: { planned: 1, written: 1, unchanged: 0, unmapped: [] },
    });
    const rerun = await run([offStored]);
    expect(rerun.report.modules).toMatchObject({ written: 0, unchanged: 1 });
    const conflict = await run([{ ...offStored, ownerOff: false }]);
    expect(conflict.report).toMatchObject({ applied: false });
    expect(conflict.report.blockers).toEqual([
      expect.objectContaining({ code: "COHORT_MODULE_ACTIVATION_CONFLICT" }),
    ]);
    expect(conflict.steps).toEqual(["read-modules:1"]);
  });

  it("mirrors the native first currencies, base entitlements, categories, markers and audits", async () => {
    const source = (file: string) => readFile(join(ROOT, file), "utf8");
    const completion = await source("apps/api/src/domains/hotelSetupFirstCurrencyCompletion.ts");
    const first = /FIRST_CURRENCIES = \[([^\]]*)\]/.exec(completion)?.[1]?.match(/[A-Z]{3}/g);
    expect(first?.sort()).toEqual([...NATIVE_PRICING_CURRENCIES].sort());
    expect(completion).toContain(
      "'newHotelFinancialsActivationTransaction', pg_current_xact_id()::text)",
    );
    expect(completion.replace(/\s+/g, " ")).toContain(
      "jsonb_build_object('propertyId', $2::uuid::text, 'currency', $8::text)",
    );
    const starter = await source("apps/api/src/domains/financeStarterCategories.ts");
    for (const [key, name, color, sortOrder] of FINANCIALS_DEFAULT_CATEGORIES)
      expect(starter).toContain(`('${key}', '${name}', '${color}', ${sortOrder})`);
    const hub = await source("apps/api/src/hotelSetupFeatureHubOrdinary.ts");
    expect(hub).toContain('const OWNER_OFF = "featureHubOwnerDisabled";');
    expect(hub).toContain("to_jsonb(pg_current_xact_id()::xid::text)");
    expect(hub).toContain("COALESCE(metadata->>'${OWNER_OFF}' = xmin::text, FALSE)");
    expect(hub.replace(/\s+/g, " ")).toContain(
      "jsonb_build_object('moduleId','financials','isActive',$6::boolean)",
    );
    // Why the switch-off's audit row has its own action (OWNER_OFF_IMPORTED).
    const trigger = await source(
      "packages/backend-migration/migrations/0449_hotel_setup_feature_hub_command.sql",
    );
    expect(trigger).toContain(
      "IF NEW.action NOT IN ('financials_module_activated','financials_module_deactivated')",
    );
    expect(OWNER_OFF_IMPORTED).not.toMatch(/^financials_module_/);
  });
});
