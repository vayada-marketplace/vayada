import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const ORGANIZATION = "60000000-0000-4000-a000-000000000001";
const AT = "2026-10-09T00:00:00.000Z";
const RUN = "vay1351-0123456789abcdef01234567";

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
        currency: index === 7 ? "IDR" : "EUR",
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
});
