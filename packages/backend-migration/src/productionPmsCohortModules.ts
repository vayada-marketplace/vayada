import type pg from "pg";

import { FINANCIALS_DEFAULT_CATEGORIES } from "./financialsDefaultCategorySeed.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { bool, uuid } from "./productionBookingValues.js";
import { carriedCohortHotel, NATIVE_PRICING_CURRENCIES } from "./productionPmsCohortSetup.js";
import { addPmsBlocker, safePmsSourceId } from "./productionPmsContext.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

/** Legacy module IDs with a runtime property module (apps/api routes/pmsModuleActivations.ts). */
const RUNTIME_MODULES: Record<string, string> = { financials: "module:financials" };
/** The native base PMS entitlements (hotelSetupFirstCurrencyCompletion BASE_ENTITLEMENTS). */
const BASE_ENTITLEMENTS = ["property-management", "pms-core", "account_access"];

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

export type StoredModuleState = {
  propertyId: string;
  status: string | null;
  /** The native first-currency default completed (newHotelFinancialsDefault ready). */
  ready: boolean;
  /** The Feature Hub Owner-off marker is live (it equals the row's xmin). */
  ownerOff: boolean;
  unbounded: boolean;
  categories: number;
  archivedCategories: number;
};

const CATEGORY_KEYS = FINANCIALS_DEFAULT_CATEGORIES.map(([key]) => key);
/** The audit action of an imported Owner-off module (the native financials_module_deactivated). */
export const OWNER_OFF_IMPORTED = "pms.financials.owner_off_imported";

/** The module state the runtime decides on, as hotelSetupFeatureHubOrdinary reads it. */
export async function readPmsCohortModules(
  client: QueryClient,
  planned: PlannedModuleActivation[],
): Promise<StoredModuleState[]> {
  if (!planned.length) return [];
  return (
    await client.query<StoredModuleState>(
      `SELECT input."propertyId"::text AS "propertyId", entitlement.status,
              coalesce(entitlement.metadata->>'newHotelFinancialsDefault' = 'ready'
                AND entitlement.metadata ? 'newHotelFinancialsActivationTransaction', FALSE)
                AS ready,
              coalesce(entitlement.metadata->>'featureHubOwnerDisabled' = entitlement.xmin::text,
                FALSE) AS "ownerOff",
              coalesce(entitlement.starts_at IS NULL AND entitlement.expires_at IS NULL, FALSE)
                AS unbounded,
              (SELECT count(*)::int FROM finance.expense_categories category
                WHERE category.property_id = input."propertyId" AND category.archived_at IS NULL
                  AND category.system_key = ANY($2::text[])) AS categories,
              (SELECT count(*)::int FROM finance.expense_categories category
                WHERE category.property_id = input."propertyId"
                  AND category.archived_at IS NOT NULL
                  AND category.system_key = ANY($2::text[])) AS "archivedCategories"
         FROM jsonb_to_recordset($1::jsonb)
              AS input("organizationId" uuid, "propertyId" uuid, "entitlementKey" text)
         LEFT JOIN identity.product_entitlements entitlement
           ON entitlement.organization_id = input."organizationId"
          AND entitlement.product = 'pms' AND entitlement.entitlement_key = input."entitlementKey"
          AND entitlement.resource_product = 'pms' AND entitlement.resource_type = 'pms_property'
          AND lower(entitlement.resource_id) = input."propertyId"::text
        ORDER BY input."propertyId"`,
      [JSON.stringify(planned), CATEGORY_KEYS],
    )
  ).rows;
}

/** True when the stored module already is the planned one, as the runtime reads it. */
export function samePmsCohortModule(
  planned: PlannedModuleActivation,
  stored: StoredModuleState | undefined,
): boolean {
  return (
    !!stored &&
    stored.ready &&
    stored.unbounded &&
    stored.categories === CATEGORY_KEYS.length &&
    (planned.active
      ? stored.status === "active" && !stored.ownerOff
      : stored.status === "suspended" && stored.ownerOff)
  );
}

/**
 * What the import does with each planned module against the target: a stored module is never
 * rewritten (an Owner toggle or operator change after the import is newer): it is unchanged when
 * the runtime reads it as planned, else preserved. A missing one is written, unless an archived
 * starter category would leave the default incomplete (native completion refuses it too).
 */
export function classifyPmsCohortModules(
  planned: PlannedModuleActivation[],
  stored: StoredModuleState[],
): {
  write: PlannedModuleActivation[];
  unchanged: string[];
  preserved: string[];
  skipped: SkippedModuleActivation[];
} {
  const result = {
    write: [] as PlannedModuleActivation[],
    unchanged: [] as string[],
    preserved: [] as string[],
    skipped: [] as SkippedModuleActivation[],
  };
  for (const module of planned) {
    const current = stored.find((row) => row.propertyId === module.propertyId);
    if (current?.status)
      (samePmsCohortModule(module, current) ? result.unchanged : result.preserved).push(
        module.propertyId,
      );
    else if (current?.archivedCategories)
      result.skipped.push({
        propertyId: module.propertyId,
        legacy: module.legacy,
        reason: "archived_starter_category",
      });
    else result.write.push(module);
  }
  return result;
}

/**
 * Writes a planned module the way native onboarding leaves it, in this transaction:
 * - the first-currency Financials default (financeStarterCategories +
 *   hotelSetupFirstCurrencyCompletion): the seven starter categories, the entitlement active and
 *   marked ready with this transaction, and the default_activated audit row;
 * - for a module legacy had off, then the Feature Hub switch-off (hotelSetupFeatureHubOrdinary):
 *   suspended with the featureHubOwnerDisabled marker of this transaction (live while it equals
 *   the row's xmin, so the Owner can switch it back on; so never call this inside a savepoint),
 *   and its audit row.
 * Never the 0449 hotel-setup marker (newHotelFinancialsOwnerDisabled) or hotelSetupTransaction.
 * The switch-off's audit row has its own action: the 0449 Feature Hub trigger rejects
 * financials_module_deactivated from a superuser or a member of the hotel-setup scope role
 * outside hotel setup (an administrative migration session), and applies it when it accepts it.
 * Not reproduced: the native pending row's separate creation, the currency command's own rows
 * (see the pricing settings), and the user actor: the migration is the actor.
 */
export async function writePmsCohortModule(
  client: QueryClient,
  input: { sourceRunId: string; completedAt: string },
  module: PlannedModuleActivation,
): Promise<void> {
  const at = new Date(input.completedAt).toISOString();
  // The rows native completion locks before it decides (FOR SHARE): a concurrent change since
  // this transaction's snapshot then fails it instead of being missed.
  await client.query(
    `SELECT id FROM identity.product_entitlements
      WHERE organization_id = $1::uuid AND product = 'pms' AND entitlement_key = ANY($3::text[])
        AND (resource_product IS NULL OR (resource_product = 'pms'
          AND resource_type = 'pms_property' AND lower(resource_id) = $2::uuid::text))
     FOR SHARE`,
    [module.organizationId, module.propertyId, [...BASE_ENTITLEMENTS, module.entitlementKey]],
  );
  await client.query(
    `SELECT id FROM finance.expense_categories
      WHERE property_id = $1::uuid AND system_key = ANY($2::text[]) FOR SHARE`,
    [module.propertyId, CATEGORY_KEYS],
  );
  await client.query(
    `INSERT INTO finance.expense_categories (property_id, system_key, name, color, sort_order)
     SELECT $1::uuid, seed.key, seed.name, seed.color, seed.sort_order
       FROM jsonb_to_recordset($2::jsonb) AS seed(key text, name text, color text, sort_order int)
     ON CONFLICT (property_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
    [
      module.propertyId,
      JSON.stringify(
        FINANCIALS_DEFAULT_CATEGORIES.map(([key, name, color, sortOrder]) => ({
          key,
          name,
          color,
          sort_order: sortOrder,
        })),
      ),
    ],
  );
  await client.query(
    `INSERT INTO identity.product_entitlements
       (organization_id, product, entitlement_key, status, resource_product, resource_type,
        resource_id, metadata, created_at, updated_at)
     VALUES ($1::uuid, 'pms', $2, CASE WHEN $4::boolean THEN 'active' ELSE 'suspended' END, 'pms',
             'pms_property', $3,
             jsonb_build_object('newHotelFinancialsDefault', 'ready',
               'newHotelFinancialsActivationTransaction', pg_current_xact_id()::text)
             || CASE WHEN $4::boolean THEN '{}'::jsonb ELSE jsonb_build_object(
               'featureHubOwnerDisabled', pg_current_xact_id()::xid::text) END,
             $5::timestamptz, $5::timestamptz)`,
    [module.organizationId, module.entitlementKey, module.propertyId, module.active, at],
  );
  const audit = (
    action: string,
    redacted: Record<string, unknown>,
    retention: string,
    privacy: string,
  ) =>
    client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
          target_resource_product, target_resource_type, target_resource_id, correlation_id,
          causation_id, redacted_payload, audit_metadata, retention_class, privacy_scope)
       VALUES ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'migration', 'pms',
               'pms_property', $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        `vay1362-migration:${input.sourceRunId}:${action}:${module.propertyId}`,
        action,
        at,
        module.propertyId,
        `vay1362-migration:${input.sourceRunId}`,
        input.sourceRunId,
        JSON.stringify(redacted),
        JSON.stringify({
          migrationRunId: input.sourceRunId,
          actorOrganizationId: module.organizationId,
          legacyModuleState: module.legacy,
        }),
        retention,
        privacy,
      ],
    );
  await audit(
    "pms.financials.default_activated",
    { propertyId: module.propertyId, currency: module.currency },
    "standard",
    "confidential",
  );
  if (!module.active)
    await audit(
      OWNER_OFF_IMPORTED,
      { moduleId: "financials", isActive: false },
      "financial",
      "internal",
    );
}
