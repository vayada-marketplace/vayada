import { type PmsRecurringPricingCommandPort } from "@vayada/domain-pms";
import { type QueryResult, type QueryResultRow } from "pg";

export type PmsRecurringPricingCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsRecurringPricingCommandPool = {
  connect(): Promise<PmsRecurringPricingCommandClient>;
  end(): Promise<void>;
};

export type PmsRecurringPricingCommandRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: PmsRecurringPricingCommandPool;
  now?: () => Date;
  randomId?: () => string;
};

export type PmsRecurringPricingCommandRepository = PmsRecurringPricingCommandPort & {
  close(): Promise<void>;
};

export function createPgPmsRecurringPricingCommandRepository(
  config: PmsRecurringPricingCommandRepositoryConfig,
): PmsRecurringPricingCommandRepository {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(
      new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
      { statusCode: 503, code: "PRICING_UNAVAILABLE" },
    );
  };
  return {
    upsertRecurringSeason: unavailable,
    upsertWeekendSurcharge: unavailable,
    upsertAdditionalGuestPricing: unavailable,
    upsertNonRefundablePricing: unavailable,
    disableRecurringPricingSource: unavailable,
    materializeRecurringPricing: unavailable,
    async close() {},
  };
}
