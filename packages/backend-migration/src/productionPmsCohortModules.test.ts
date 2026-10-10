import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FINANCIALS_DEFAULT_CATEGORIES } from "./financialsDefaultCategorySeed.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  OWNER_OFF_IMPORTED,
  classifyPmsCohortModules,
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

/**
 * Seven carried cohort hotels: 1-3 ready for the module; 4 organization-wide Financials; 5 no
 * active base entitlement; 6 an operator, not the owner; 7 an unsupported currency.
 */
function plan(moduleActivations: IdentitySourceRow[], cohort = true) {
  const indexes = [1, 2, 3, 4, 5, 6, 7];
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
      financialsOwnerOrganizationIds: index === 6 ? [] : [ORGANIZATION],
      pmsBaseOrganizationIds: index === 5 ? [] : [ORGANIZATION],
      organizationFinancialsIds: index === 4 ? [ORGANIZATION] : [],
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
        currency: index === 7 ? "JPY" : "EUR",
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
  archivedCategories: 0,
};

describe("production PMS cohort module activations", () => {
  it("maps legacy financials on, off and absent, and reports what it cannot carry", () => {
    const result = plan([
      legacy(1, "financials", true),
      legacy(2, "financials", false),
      legacy(2, "affiliates", true),
      legacy(3, "affiliates", false), // inactive: nothing to report
      legacy(4, "financials", true),
      legacy(5, "financials", true),
      legacy(6, "financials", false),
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.moduleActivations).toEqual(
      (
        [
          [1, true, "on"],
          [2, false, "off"],
          [3, false, "absent"],
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
    expect(result.skippedModules).toEqual([
      { propertyId: `${PROPERTY}4`, legacy: "on", reason: "organization_financials" },
      { propertyId: `${PROPERTY}5`, legacy: "on", reason: "base_entitlement" },
      { propertyId: `${PROPERTY}6`, legacy: "off", reason: "owner_organization" },
      { propertyId: `${PROPERTY}7`, legacy: "absent", reason: "pricing_currency" },
    ]);
    expect(result.unmappedModules).toEqual([`${HOTEL}2:affiliates`]);
    // An invalid legacy row blocks the run instead of aborting the plan.
    expect(plan([legacy(1, "financials", "yes")]).blockers).toEqual([
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "pms.hotels",
        sourceId: `${HOTEL}1`,
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

  it("never rewrites a stored module, and writes a missing one unless a category is archived", () => {
    expect(samePmsCohortModule(offModule, offStored)).toBe(true);
    const onModule = {
      ...offModule,
      propertyId: `${PROPERTY}2`,
      active: true,
      legacy: "on" as const,
    };
    const missing = { ...offModule, propertyId: `${PROPERTY}3` };
    const archived = { ...offModule, propertyId: `${PROPERTY}4` };
    const none = { status: null, ready: false, ownerOff: false, unbounded: false, categories: 0 };
    expect(
      classifyPmsCohortModules(
        [offModule, onModule, missing, archived],
        [
          offStored,
          // The Owner switched it off after the import: newer on the target.
          { ...offStored, propertyId: onModule.propertyId },
          { ...none, propertyId: missing.propertyId, archivedCategories: 0 },
          { ...none, propertyId: archived.propertyId, archivedCategories: 1 },
        ],
      ),
    ).toEqual({
      write: [missing],
      unchanged: [offModule.propertyId],
      preserved: [
        {
          propertyId: onModule.propertyId,
          legacy: "on",
          status: "suspended",
          ready: true,
          ownerOff: true,
        },
      ],
      skipped: [
        { propertyId: archived.propertyId, legacy: "off", reason: "archived_starter_category" },
      ],
    });
    // Suspended without a live Owner-off marker, or incomplete, is not the planned module.
    for (const stored of [
      { ...offStored, ownerOff: false },
      { ...offStored, categories: 6 },
      { ...offStored, ready: false },
    ])
      expect(samePmsCohortModule(offModule, stored)).toBe(false);
  });

  it("writes missing modules after verification, verifies them, and keeps stored ones", async () => {
    const run = async (stored: Array<Record<string, unknown>>, mode: "apply" | "dry-run") => {
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
        { sourceRunId: RUN, mode },
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
              skippedModules: [],
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
        },
      );
      return { report, steps };
    };
    const missing = { ...offStored, status: null, archivedCategories: 0 };
    const preview = await run([missing], "dry-run");
    expect(preview.steps).toEqual(["read-modules:1"]);
    expect(preview.report.modules).toEqual({
      planned: 1,
      writes: 1,
      unchanged: 0,
      preserved: [],
      skipped: [],
      unmapped: [],
    });
    const fresh = await run([missing], "apply");
    expect(fresh.steps).toEqual(["read-modules:1", "write", "module", "read-modules:2"]);
    expect(fresh.report).toMatchObject({ applied: true, modules: { writes: 1 } });
    const rerun = await run([offStored], "apply");
    expect(rerun.report.modules).toMatchObject({ writes: 0, unchanged: 1 });
    // An Owner change after the import is kept, not rewritten, and does not block.
    const changed = await run([{ ...offStored, status: "active", ownerOff: false }], "apply");
    expect(changed.report).toMatchObject({
      applied: true,
      blockers: [],
      modules: {
        writes: 0,
        preserved: [
          {
            propertyId: offModule.propertyId,
            legacy: "off",
            status: "active",
            ready: true,
            ownerOff: false,
          },
        ],
      },
    });
    expect(changed.steps).toEqual(["read-modules:1", "write"]);
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
