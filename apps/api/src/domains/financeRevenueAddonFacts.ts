import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  normalizeFinanceReportingDecimal,
  parseFinanceRevenueQuery,
  type FinanceReportingComparison,
  type FinanceReportingMoney,
} from "@vayada/domain-finance";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
export type FinanceRevenueAddonFactsPool = Pick<Client, "query"> & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};
export type FinanceRevenueAddonFactsClient = Pick<Client, "query">;
export type FinanceRevenueAddonFact = {
  period: "current" | "comparison";
  recognizedOn: string;
  ownership: "property" | "partner";
  revenueAmount: string;
};
export type FinanceRevenueAddonGap =
  | {
      code: "addon_revenue_currency_mismatch";
      count: number;
      currency: string;
      amount?: FinanceReportingMoney;
    }
  | {
      code: "addon_fulfillment_missing" | "addon_fulfillment_conflicting";
      count: number;
    };
export type FinanceRevenueAddonFacts = {
  rows: FinanceRevenueAddonFact[];
  fulfilledBookings: { current: number; comparison: number };
  sourceFreshness: {
    bookingAddonRevenueThrough: string | null;
    bookingAddonRevenueAt: string | null;
  };
  incompleteEvidence: FinanceRevenueAddonGap[];
};
export type FinanceRevenueAddonFactsInput = {
  propertyId: string;
  currency: string;
  periods: FinanceReportingComparison;
};
export type FinanceRevenueAddonFactsReadPort = {
  read(input: FinanceRevenueAddonFactsInput): Promise<FinanceRevenueAddonFacts>;
  close(): Promise<void>;
};

type FactRow = Omit<FinanceRevenueAddonFact, "period" | "ownership"> & {
  period: string;
  ownership: string;
};
type FulfilledRow = { period: string; count: number };
type FreshnessRow = {
  bookingAddonRevenueThrough: string | null;
  bookingAddonRevenueAt: string | null;
};
type GapRow = {
  code: FinanceRevenueAddonGap["code"];
  count: number;
  amount: string | null;
  currency: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINOR_DIGITS = `CASE WHEN currency::text IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0 WHEN currency::text IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3 WHEN currency::text IN ('CLF','UYW') THEN 4 ELSE 2 END`;
const PROPERTY_REVENUE = `CASE WHEN gross_amount IS NULL THEN NULL WHEN ownership_kind='property' THEN gross_amount ELSE round(gross_amount*partner_commission_rate/100,${MINOR_DIGITS}) END`;
const SCOPED = `SELECT evidence.* FROM booking.finance_addon_revenue_evidence evidence WHERE property_id=$1::uuid AND (recognized_on BETWEEN $3::date AND $4::date OR recognized_on BETWEEN $5::date AND $6::date)`;

export function createPgFinanceRevenueAddonFacts(config: {
  connectionString?: string;
  pool?: FinanceRevenueAddonFactsPool;
  max?: number;
}): FinanceRevenueAddonFactsReadPort {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance revenue add-on facts require a connection string");
  const ownsPool = !config.pool;
  const pool: FinanceRevenueAddonFactsPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async read(input) {
      return consistentRead(pool, (client) => readFinanceRevenueAddonFacts(client, input));
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

export async function readFinanceRevenueAddonFacts(
  client: FinanceRevenueAddonFactsClient,
  input: FinanceRevenueAddonFactsInput,
): Promise<FinanceRevenueAddonFacts> {
  const propertyId = uuid(input.propertyId);
  if (!/^[A-Z]{3}$/.test(input.currency))
    throw new TypeError("Finance revenue currency is malformed");
  const current = parseFinanceRevenueQuery(input.periods.current);
  const comparison = parseFinanceRevenueQuery(input.periods.comparison);
  if (!current || !comparison || comparison.to >= current.from)
    throw new TypeError("Finance revenue comparison periods are malformed");
  const values = [
    propertyId,
    input.currency,
    current.from,
    current.to,
    comparison.from,
    comparison.to,
  ];
  const rows = await readFacts(client, values);
  const freshness = await readFreshness(client, values);
  return {
    rows: rows.map(fact),
    fulfilledBookings: await readFulfilledBookings(client, values),
    sourceFreshness: {
      bookingAddonRevenueThrough: freshness.bookingAddonRevenueThrough,
      bookingAddonRevenueAt: instant(freshness.bookingAddonRevenueAt),
    },
    incompleteEvidence: (await readGaps(client, values)).map(gap),
  };
}

// Curated Finance-safe Booking views are the integration boundary; this adapter never reads guest PII.
// prettier-ignore
async function readFacts(client: Pick<Client, "query">, values: readonly unknown[]): Promise<FactRow[]> {
  return (await client.query<FactRow>(`WITH scoped AS (${SCOPED}),reporting AS (SELECT *,CASE WHEN recognized_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period FROM scoped WHERE currency=$2) SELECT period,recognized_on::text AS "recognizedOn",ownership_kind AS ownership,COALESCE(sum(${PROPERTY_REVENUE}),0)::text AS "revenueAmount" FROM reporting GROUP BY period,recognized_on,ownership_kind HAVING count(${PROPERTY_REVENUE})>0 ORDER BY period,recognized_on,ownership_kind`, values)).rows;
}

// Attach rate is non-monetary: intersect fulfilled add-ons with occupied bookings, independent of currency.
// prettier-ignore
async function readFulfilledBookings(client: Pick<Client, "query">, values: readonly unknown[]) {
  const rows = (await client.query<FulfilledRow>(`WITH scoped AS (${SCOPED}),fulfilled AS (SELECT guest_booking_id,CASE WHEN recognized_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period FROM scoped WHERE economic_event='fulfillment' AND length($2::text)=3),eligible AS (SELECT guest_booking_id,CASE WHEN recognized_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period FROM booking.finance_nightly_revenue_evidence WHERE property_id=$1::uuid AND (recognized_on BETWEEN $3::date AND $4::date OR recognized_on BETWEEN $5::date AND $6::date) GROUP BY guest_booking_id,period HAVING sum(occupied_room_nights)>0) SELECT fulfilled.period,count(DISTINCT fulfilled.guest_booking_id)::int AS count FROM fulfilled JOIN eligible USING (guest_booking_id,period) GROUP BY fulfilled.period`, values)).rows;
  const counts = { current: 0, comparison: 0 };
  for (const row of rows) {
    if ((row.period !== "current" && row.period !== "comparison") || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error("Finance revenue add-on attachment facts are invalid");
    counts[row.period] = row.count;
  }
  return counts;
}

// Freshness describes the source boundary, including evidence excluded for currency mismatch.
// prettier-ignore
async function readFreshness(client: Pick<Client, "query">, values: readonly unknown[]) {
  return (await client.query<FreshnessRow>(`WITH scoped AS (${SCOPED}) SELECT max(recognized_on)::text AS "bookingAddonRevenueThrough",max(created_at)::text AS "bookingAddonRevenueAt" FROM scoped WHERE length($2::text)=3`, values)).rows[0] ?? { bookingAddonRevenueThrough: null, bookingAddonRevenueAt: null };
}

// prettier-ignore
async function readGaps(client: Pick<Client, "query">, values: readonly unknown[]): Promise<GapRow[]> {
  return (await client.query<GapRow>(`WITH scoped AS (${SCOPED}),gaps AS (SELECT 'addon_revenue_currency_mismatch'::text AS code,count(*)::int AS count,CASE WHEN count(gross_amount)=count(*) THEN sum(${PROPERTY_REVENUE})::text END AS amount,currency::text AS currency FROM scoped WHERE currency<>$2 GROUP BY currency UNION ALL SELECT CASE WHEN evidence_quality='conflicting' THEN 'addon_fulfillment_conflicting' ELSE 'addon_fulfillment_missing' END,count(*)::int,NULL,NULL FROM scoped WHERE economic_event='missing_fulfillment' GROUP BY evidence_quality) SELECT * FROM gaps WHERE count>0 ORDER BY code,currency NULLS FIRST`, values)).rows;
}

function fact(row: FactRow): FinanceRevenueAddonFact {
  if (
    (row.period !== "current" && row.period !== "comparison") ||
    !localDate(row.recognizedOn) ||
    (row.ownership !== "property" && row.ownership !== "partner")
  )
    throw new Error("Finance revenue add-on facts are invalid");
  return {
    period: row.period,
    recognizedOn: row.recognizedOn,
    ownership: row.ownership,
    revenueAmount: normalizeFinanceReportingDecimal(row.revenueAmount),
  };
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function gap(row: GapRow): FinanceRevenueAddonGap {
  if (!Number.isSafeInteger(row.count) || row.count < 1)
    throw new Error("Finance revenue incomplete add-on evidence is invalid");
  if (row.code === "addon_revenue_currency_mismatch") {
    if (row.currency === null || !/^[A-Z]{3}$/.test(row.currency))
      throw new Error("Finance revenue incomplete add-on currency is invalid");
    return row.amount === null
      ? { code: row.code, count: row.count, currency: row.currency }
      : {
          code: row.code,
          count: row.count,
          currency: row.currency,
          amount: { amount: normalizeFinanceReportingDecimal(row.amount), currency: row.currency },
        };
  }
  if (row.amount !== null || row.currency !== null)
    throw new Error("Finance revenue incomplete add-on evidence shape is invalid");
  return { code: row.code, count: row.count };
}
function instant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Finance revenue freshness is invalid");
  return parsed.toISOString();
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance revenue property id is malformed");
  return value.toLowerCase();
}
// prettier-ignore
async function consistentRead<T>(pool: FinanceRevenueAddonFactsPool, read: (client: Client) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
