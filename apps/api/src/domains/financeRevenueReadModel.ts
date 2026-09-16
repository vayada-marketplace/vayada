import { getTimezone } from "countries-and-timezones";

import {
  financeRevenuePeriod,
  type FinanceRevenueQuery,
  type FinanceRevenueResponse,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";

import type { FinanceRevenueAddonFactsReadPort } from "./financeRevenueAddonFacts.js";
import { composeFinanceRevenueResponse } from "./financeRevenueResponse.js";
import type { FinanceRevenueRoomFactsReadPort } from "./financeRevenueRoomFacts.js";

export type FinanceRevenuePropertyContextReadPort = {
  getPropertyContext(propertyId: string): Promise<{
    source: {
      ownerDomain: "hotel_catalog";
      entityType: "property_profile";
      entityId: string;
      revision: string;
    };
    timeZone: string | null;
    updatedAt: string;
  } | null>;
};
export type FinanceRevenueReadModel = {
  revenue(propertyId: string, query: FinanceRevenueQuery): Promise<FinanceRevenueResponse | null>;
};

export class FinanceRevenueEvidenceError extends Error {
  readonly code = "evidence_unavailable";
}

export function createFinanceRevenueReadModel(config: {
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  propertyContext: FinanceRevenuePropertyContextReadPort;
  rooms: FinanceRevenueRoomFactsReadPort;
  addOns: FinanceRevenueAddonFactsReadPort;
  now?: () => Date;
}): FinanceRevenueReadModel {
  if (!config.pricing || !config.propertyContext || !config.rooms || !config.addOns)
    throw new Error("Finance revenue read model requires typed evidence ports");
  return {
    async revenue(rawPropertyId, query) {
      const propertyId = uuid(rawPropertyId);
      const periods = financeRevenuePeriod(query);
      const [pricing, context] = await Promise.all([
        config.pricing.getPropertyPricingCurrency(propertyId),
        config.propertyContext.getPropertyContext(propertyId),
      ]);
      if (!context) return null;
      if (
        !pricing ||
        pricing.contractVersion !== PMS_PRICING_CONTRACT_VERSION ||
        typeof pricing.propertyId !== "string" ||
        pricing.propertyId.toLowerCase() !== propertyId ||
        !/^[A-Z]{3}$/.test(pricing.currency) ||
        !Number.isSafeInteger(pricing.pricingCurrencyRevision) ||
        pricing.pricingCurrencyRevision < 1 ||
        !context.source ||
        context.source.ownerDomain !== "hotel_catalog" ||
        context.source.entityType !== "property_profile" ||
        typeof context.source.entityId !== "string" ||
        context.source.entityId.toLowerCase() !== propertyId ||
        !/^profile:[1-9]\d*$/.test(context.source.revision) ||
        !isCanonicalFinanceTimeZone(context.timeZone) ||
        !utc(pricing.createdAt) ||
        !utc(pricing.updatedAt) ||
        !utc(context.updatedAt)
      )
        throw new FinanceRevenueEvidenceError(
          "Property currency or timezone evidence is unavailable",
        );
      const scope = { propertyId, currency: pricing.currency, periods };
      const [rooms, addOns] = await Promise.all([
        config.rooms.read(scope),
        config.addOns.read(scope),
      ]);
      return composeFinanceRevenueResponse({
        propertyId,
        currency: pricing.currency,
        timeZone: context.timeZone,
        generatedAt: (config.now?.() ?? new Date()).toISOString(),
        sourceFreshness: {
          pmsPricing: pricing.updatedAt,
          pmsPricingRevision: String(pricing.pricingCurrencyRevision),
          hotelCatalog: context.updatedAt,
          hotelCatalogRevision: context.source.revision,
        },
        rooms,
        addOns,
      });
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance revenue property id is malformed");
  return value.toLowerCase();
}
export function isCanonicalFinanceTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const zone = getTimezone(value);
    return zone?.name === value && zone.aliasOf === null;
  } catch {
    return false;
  }
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
