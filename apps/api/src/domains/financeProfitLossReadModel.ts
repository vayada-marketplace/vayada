import {
  financeProfitLossPeriods,
  parseFinanceProfitLossQuery,
  type FinanceProfitLossExpenseCategoryRow,
  type FinanceProfitLossQuery,
  type FinanceProfitLossResponse,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";

import type { FinanceProfitLossFactsReadPort } from "./financeProfitLossFacts.js";
import { composeFinanceProfitLossResponse } from "./financeProfitLossResponse.js";
import {
  isCanonicalFinanceTimeZone,
  type FinanceRevenuePropertyContextReadPort,
} from "./financeRevenueReadModel.js";

export type FinanceProfitLossReadModel = {
  profitLoss(
    propertyId: string,
    query: FinanceProfitLossQuery,
  ): Promise<{
    response: FinanceProfitLossResponse;
    categoryRows: FinanceProfitLossExpenseCategoryRow[];
  } | null>;
};

export class FinanceProfitLossEvidenceError extends Error {
  readonly code = "evidence_unavailable";
}

export function createFinanceProfitLossReadModel(config: {
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  propertyContext: FinanceRevenuePropertyContextReadPort;
  facts: Pick<FinanceProfitLossFactsReadPort, "read">;
  now?: () => Date;
}): FinanceProfitLossReadModel {
  if (!config.pricing || !config.propertyContext || !config.facts)
    throw new Error("Finance profit and loss read model requires typed evidence ports");
  return {
    async profitLoss(rawPropertyId, rawQuery) {
      const propertyId = uuid(rawPropertyId);
      const query = parseFinanceProfitLossQuery(rawQuery);
      if (!query) throw new TypeError("Finance profit and loss query is malformed");
      const [pricing, context] = await Promise.all([
        config.pricing.getPropertyPricingCurrency(propertyId),
        config.propertyContext.getPropertyContext(propertyId),
      ]);
      if (!context) return null;
      if (!validEvidence(propertyId, pricing, context))
        throw new FinanceProfitLossEvidenceError(
          "Property currency or timezone evidence is unavailable",
        );
      const generated = config.now?.() ?? new Date();
      if (!Number.isFinite(generated.getTime()))
        throw new FinanceProfitLossEvidenceError("Generation time is unavailable");
      const asOf = localDate(generated, context.timeZone!);
      const facts = await config.facts.read({
        propertyId,
        currency: pricing!.currency,
        periods: financeProfitLossPeriods(query, asOf),
      });
      const response = composeFinanceProfitLossResponse({
        ...facts,
        propertyId,
        currency: pricing!.currency,
        timeZone: context.timeZone!,
        generatedAt: generated.toISOString(),
        asOf,
        query,
        sourceFreshness: {
          pmsPricing: pricing!.updatedAt,
          pmsPricingRevision: String(pricing!.pricingCurrencyRevision),
          hotelCatalog: context.updatedAt,
          hotelCatalogRevision: context.source.revision,
          ...facts.sourceFreshness,
        },
      });
      return { response, categoryRows: [...facts.categoryRows] };
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
    pricing.propertyId.toLowerCase() === propertyId &&
    /^[A-Z]{3}$/.test(pricing.currency) &&
    Number.isSafeInteger(pricing.pricingCurrencyRevision) &&
    pricing.pricingCurrencyRevision >= 1 &&
    context.source?.ownerDomain === "hotel_catalog" &&
    context.source.entityType === "property_profile" &&
    context.source.entityId.toLowerCase() === propertyId &&
    /^profile:[1-9]\d*$/.test(context.source.revision) &&
    isCanonicalFinanceTimeZone(context.timeZone) &&
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
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance profit and loss property id is malformed");
  return value.toLowerCase();
}
