import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { bool, uuid } from "./productionBookingValues.js";
import { carriedCohortHotel, NATIVE_PRICING_CURRENCIES } from "./productionPmsCohortSetup.js";
import { addPmsBlocker, safePmsSourceId } from "./productionPmsContext.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

/** Legacy module IDs with a runtime property module (apps/api routes/pmsModuleActivations.ts). */
const RUNTIME_MODULES: Record<string, string> = { financials: "module:financials" };

export type LegacyModuleState = "on" | "off" | "absent";
export type PlannedModuleActivation = {
  organizationId: string;
  propertyId: string;
  entitlementKey: string;
  active: boolean;
  currency: string;
  legacy: LegacyModuleState;
};
export type SkippedModuleActivation = {
  propertyId: string;
  legacy: LegacyModuleState;
  reason:
    | "owner_organization"
    | "base_entitlement"
    | "organization_financials"
    | "pricing_currency"
    | "archived_starter_category";
};

/**
 * VAY-1362: the legacy PMS module activations (pms.property_module_activations) of carried
 * cohort hotels as the runtime's property-scoped module:* entitlements. Only "financials" has a
 * runtime module; "affiliates" changes are retired (410) and other IDs have none, so active ones
 * are reported. Legacy reads a hotel without a row as off. A property gets its module only with
 * what native onboarding needs for it, else it is reported as skipped: one active hotel_group
 * owning both native links (the native pending default and the Feature Hub require the owner),
 * an active, unsuspended base PMS entitlement of that organization, no organization-wide
 * Financials entitlement (native completion refuses a suspended one; a property row would
 * override an active one), and pricing settings in a first currency.
 */
export function planPmsCohortModules(
  context: PmsBuildContext,
  legacy: IdentitySourceRow[],
  records: PmsTargetRecord[],
): { planned: PlannedModuleActivation[]; skipped: SkippedModuleActivation[]; unmapped: string[] } {
  const planned: PlannedModuleActivation[] = [];
  const skipped: SkippedModuleActivation[] = [];
  const unmapped: string[] = [];
  if (!context.cohort) return { planned, skipped, unmapped };
  const currencyByProperty = new Map(
    records
      .filter((record) => record.targetTable === "property_pricing_settings")
      .map((record) => [record.targetId, String(record.row["currency"])]),
  );
  const properties = new Map(
    (context.target.cohortProperties ?? []).map((row) => [row.propertyId, row]),
  );
  for (const hotel of context.rowsByTable.get("hotels") ?? [])
    try {
      const hotelId = uuid(hotel.data["id"], "id");
      const propertyId = context.propertyByHotel.get(hotelId);
      if (!propertyId || !carriedCohortHotel(context, hotelId)) continue;
      const rows = legacy.filter((row) => String(row.data["hotel_id"]).toLowerCase() === hotelId);
      unmapped.push(
        ...rows
          .filter((row) => row.data["is_active"] === true)
          .map((row) => String(row.data["module_id"]))
          .filter((moduleId) => !Object.hasOwn(RUNTIME_MODULES, moduleId))
          .map((moduleId) => `${hotelId}:${moduleId}`),
      );
      const financials = rows.find((row) => row.data["module_id"] === "financials");
      const active = !!financials && bool(financials.data["is_active"], "is_active");
      const state: LegacyModuleState = financials ? (active ? "on" : "off") : "absent";
      const property = properties.get(propertyId);
      const [organizationId] = property?.organizationIds ?? [];
      const currency = currencyByProperty.get(propertyId);
      const reason: SkippedModuleActivation["reason"] | null =
        property?.organizationIds.length !== 1 ||
        !property.financialsOwnerOrganizationIds?.includes(organizationId!)
          ? "owner_organization"
          : !property.pmsBaseOrganizationIds?.includes(organizationId!)
            ? "base_entitlement"
            : property.organizationFinancialsIds?.includes(organizationId!)
              ? "organization_financials"
              : !currency || !NATIVE_PRICING_CURRENCIES.has(currency)
                ? "pricing_currency"
                : null;
      if (reason) skipped.push({ propertyId, legacy: state, reason });
      else
        planned.push({
          organizationId: organizationId!,
          propertyId,
          entitlementKey: RUNTIME_MODULES["financials"]!,
          active,
          currency: currency!,
          legacy: state,
        });
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.hotels",
        safePmsSourceId(hotel),
        `Legacy module activation: ${error instanceof Error ? error.message : "invalid"}`,
      );
    }
  const byProperty = (left: { propertyId: string }, right: { propertyId: string }) =>
    left.propertyId.localeCompare(right.propertyId);
  return { planned: planned.sort(byProperty), skipped: skipped.sort(byProperty), unmapped };
}
