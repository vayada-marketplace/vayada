import type { RequestContext } from "@vayada/backend-auth";

export type ChannelDatePriceScope = {
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  stayDate: string;
};
export type ChannelDatePrice = { amountDecimal: string | null; currency: string; revision: number };
export type ChannelDatePriceCommand = ChannelDatePriceScope & {
  amountDecimal: string | null;
  currency: string;
  expectedRevision: number;
  commandId: string;
};
export type ChannelDatePricesPort = {
  get(scope: ChannelDatePriceScope): Promise<ChannelDatePrice | null>;
  put(context: RequestContext, command: ChannelDatePriceCommand): Promise<ChannelDatePrice | null>;
  close(): Promise<void>;
};

export function createPgChannelDatePrices(connectionString: string): ChannelDatePricesPort {
  return {
    async get() {
      throw Object.assign(
        new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
        { statusCode: 503, code: "PRICING_UNAVAILABLE" },
      );
    },
    async put() {
      throw Object.assign(
        new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
        { statusCode: 503, code: "PRICING_UNAVAILABLE" },
      );
    },
    async close() {},
  };
}
