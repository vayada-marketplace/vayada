import {
  financeDashboardPeriods,
  parseFinanceDashboardQuery,
  type FinanceDashboardQuery,
  type FinanceDashboardResponse,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";

import type { FinanceDashboardExpenseFacts } from "./financeDashboardExpenseFacts.js";
import { composeFinanceDashboardResponse } from "./financeDashboardResponse.js";
import type { FinanceRevenueAddonFacts } from "./financeRevenueAddonFacts.js";
import {
  isCanonicalFinanceTimeZone,
  type FinanceRevenuePropertyContextReadPort,
} from "./financeRevenueReadModel.js";
import type { FinanceRevenueRoomFacts } from "./financeRevenueRoomFacts.js";

export type FinanceDashboardFactsReadPort = {
  // Implementations must read all three results from one database snapshot.
  readConsistent(input: {
    revenue: {
      propertyId: string;
      currency: string;
      periods: ReturnType<typeof financeDashboardPeriods>["monthToDate"];
    };
    expenses: {
      propertyId: string;
      currency: string;
      asOf: string;
      monthToDate: ReturnType<typeof financeDashboardPeriods>["monthToDate"];
      daily: ReturnType<typeof financeDashboardPeriods>["daily"];
    };
  }): Promise<{
    rooms: FinanceRevenueRoomFacts;
    addOns: FinanceRevenueAddonFacts;
    expenses: FinanceDashboardExpenseFacts;
  }>;
};

export type FinanceDashboardReadModel = {
  dashboard(
    propertyId: string,
    query: FinanceDashboardQuery,
  ): Promise<FinanceDashboardResponse | null>;
};

export class FinanceDashboardEvidenceError extends Error {
  readonly code = "evidence_unavailable";
}

export function createFinanceDashboardReadModel(config: {
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  propertyContext: FinanceRevenuePropertyContextReadPort;
  facts: FinanceDashboardFactsReadPort;
  now?: () => Date;
}): FinanceDashboardReadModel {
  if (!config.pricing || !config.propertyContext || !config.facts)
    throw new Error("Finance Dashboard read model requires typed evidence ports");
  return {
    async dashboard(rawPropertyId, rawQuery) {
      const propertyId = uuid(rawPropertyId);
      const query = parseFinanceDashboardQuery(rawQuery);
      if (!query) throw new TypeError("Finance Dashboard query is malformed");
      const [pricing, context] = await Promise.all([
        config.pricing.getPropertyPricingCurrency(propertyId),
        config.propertyContext.getPropertyContext(propertyId),
      ]);
      if (!context) return null;
      if (!validEvidence(propertyId, pricing, context))
        throw new FinanceDashboardEvidenceError(
          "Property currency or timezone evidence is unavailable",
        );
      const generated = config.now?.() ?? new Date();
      if (!Number.isFinite(generated.getTime()))
        throw new FinanceDashboardEvidenceError("Dashboard generation time is unavailable");
      const asOf = query.asOf ?? localDate(generated, context.timeZone!);
      const periods = financeDashboardPeriods(asOf);
      const revenuePeriods = {
        current: {
          from:
            periods.daily.from < periods.monthToDate.current.from
              ? periods.daily.from
              : periods.monthToDate.current.from,
          to: asOf,
        },
        comparison: periods.monthToDate.comparison,
      };
      const { rooms, addOns, expenses } = await config.facts.readConsistent({
        revenue: { propertyId, currency: pricing!.currency, periods: revenuePeriods },
        expenses: {
          propertyId,
          currency: pricing!.currency,
          asOf,
          monthToDate: periods.monthToDate,
          daily: periods.daily,
        },
      });
      return composeFinanceDashboardResponse({
        propertyId,
        currency: pricing!.currency,
        timeZone: context.timeZone!,
        generatedAt: generated.toISOString(),
        sourceFreshness: {
          pmsPricing: pricing!.updatedAt,
          pmsPricingRevision: String(pricing!.pricingCurrencyRevision),
          hotelCatalog: context.updatedAt,
          hotelCatalogRevision: context.source.revision,
        },
        periods,
        rooms,
        addOns,
        expenses,
      });
    },
  };
}

type Pricing = Awaited<ReturnType<PmsPricingReadPort["getPropertyPricingCurrency"]>>;
type Context = Awaited<ReturnType<FinanceRevenuePropertyContextReadPort["getPropertyContext"]>>;
function validEvidence(propertyId: string, pricing: Pricing, context: Context): boolean {
  return !!(
    pricing &&
    context &&
    pricing.contractVersion === PMS_PRICING_CONTRACT_VERSION &&
    typeof pricing.propertyId === "string" &&
    pricing.propertyId.toLowerCase() === propertyId &&
    /^[A-Z]{3}$/.test(pricing.currency) &&
    Number.isSafeInteger(pricing.pricingCurrencyRevision) &&
    pricing.pricingCurrencyRevision >= 1 &&
    context.source?.ownerDomain === "hotel_catalog" &&
    context.source.entityType === "property_profile" &&
    typeof context.source.entityId === "string" &&
    context.source.entityId.toLowerCase() === propertyId &&
    /^profile:[1-9]\d*$/.test(context.source.revision) &&
    isCanonicalFinanceTimeZone(context.timeZone) &&
    utc(pricing.createdAt) &&
    utc(pricing.updatedAt) &&
    utc(context.updatedAt)
  );
}
function localDate(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}
function utc(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^((?!0000)\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance Dashboard property id is malformed");
  return value.toLowerCase();
}
