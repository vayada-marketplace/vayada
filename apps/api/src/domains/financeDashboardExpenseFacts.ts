import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  FINANCE_DASHBOARD_WINDOW_DAYS,
  normalizeFinanceReportingDecimal,
  parseFinanceRevenueQuery,
  type FinanceReportingComparison,
  type FinanceReportingMoney,
  type FinanceReportingRange,
} from "@vayada/domain-finance";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
export type FinanceDashboardExpenseFactsPool = Pick<Client, "query"> & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};
export type FinanceDashboardExpenseFactsClient = Pick<Client, "query">;
export type FinanceDashboardExpenseGap = {
  code: "expense_currency_mismatch" | "recurring_expense_currency_mismatch";
  count: number;
  amount: FinanceReportingMoney;
};
export type FinanceDashboardExpenseFacts = {
  totals: { current: string; comparison: string };
  daily: Array<{ date: string; amount: string }>;
  upcoming: Array<{
    date: string;
    kind: "recurring_expense";
    amount: string;
    predicted: true;
  }>;
  sourceFreshness: {
    financeExpensesAt: string | null;
    financeRecurringExpensesAt: string | null;
  };
  incompleteEvidence: FinanceDashboardExpenseGap[];
};
export type FinanceDashboardExpenseFactsInput = {
  propertyId: string;
  currency: string;
  asOf: string;
  monthToDate: FinanceReportingComparison;
  daily: FinanceReportingRange;
};
export type FinanceDashboardExpenseFactsReadPort = {
  read(input: FinanceDashboardExpenseFactsInput): Promise<FinanceDashboardExpenseFacts>;
  close(): Promise<void>;
};

type TotalsRow = { current: string; comparison: string };
type DailyRow = { date: string; amount: string };
type UpcomingRow = { date: string; amount: string };
type FreshnessRow = {
  financeExpensesAt: string | null;
  financeRecurringExpensesAt: string | null;
};
type GapRow = {
  code: FinanceDashboardExpenseGap["code"];
  count: number;
  amount: string;
  currency: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = `SELECT e.id,e.incurred_on,e.currency,CASE WHEN e.entry_kind='reversal' THEN -e.amount ELSE e.amount END AS amount FROM finance.expenses e WHERE e.property_id=$1::uuid UNION ALL SELECT correction.id,correction.incurred_on,prior.currency,-prior.amount FROM finance.expenses correction JOIN finance.expenses prior ON prior.id=correction.reverses_expense_id WHERE correction.property_id=$1::uuid AND correction.entry_kind='correction'`;

export function createPgFinanceDashboardExpenseFacts(config: {
  connectionString?: string;
  pool?: FinanceDashboardExpenseFactsPool;
  max?: number;
}): FinanceDashboardExpenseFactsReadPort {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance Dashboard expense facts require a connection string");
  const ownsPool = !config.pool;
  const pool: FinanceDashboardExpenseFactsPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async read(input) {
      return consistentRead(pool, (client) => readFinanceDashboardExpenseFacts(client, input));
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

export async function readFinanceDashboardExpenseFacts(
  client: FinanceDashboardExpenseFactsClient,
  input: FinanceDashboardExpenseFactsInput,
): Promise<FinanceDashboardExpenseFacts> {
  const propertyId = uuid(input.propertyId);
  if (!/^[A-Z]{3}$/.test(input.currency) || !localDate(input.asOf))
    throw new TypeError("Finance Dashboard expense scope is malformed");
  const current = parseFinanceRevenueQuery(input.monthToDate.current);
  const comparison = parseFinanceRevenueQuery(input.monthToDate.comparison);
  const daily = parseFinanceRevenueQuery(input.daily);
  if (
    !current ||
    !comparison ||
    !daily ||
    comparison.to >= current.from ||
    current.to !== input.asOf ||
    daily.to !== input.asOf ||
    days(daily.from, daily.to) !== FINANCE_DASHBOARD_WINDOW_DAYS
  )
    throw new TypeError("Finance Dashboard expense periods are malformed");
  const values = [
    propertyId,
    input.currency,
    current.from,
    current.to,
    comparison.from,
    comparison.to,
    daily.from,
    daily.to,
    input.asOf,
  ];
  const totals = await readTotals(client, values);
  const dailyRows = await readDaily(client, values);
  const upcoming = await readUpcoming(client, values);
  const freshness = await readFreshness(client, values);
  const ledgerGaps = await readLedgerGaps(client, values);
  const recurringGaps = await readRecurringGaps(client, values);
  return {
    totals: {
      current: normalizeFinanceReportingDecimal(totals.current),
      comparison: normalizeFinanceReportingDecimal(totals.comparison),
    },
    daily: dailyRows.map((row) => ({
      date: validDate(row.date),
      amount: normalizeFinanceReportingDecimal(row.amount),
    })),
    upcoming: upcoming.map((row) => ({
      date: validDate(row.date),
      kind: "recurring_expense",
      amount: normalizeFinanceReportingDecimal(row.amount),
      predicted: true,
    })),
    sourceFreshness: {
      financeExpensesAt: instant(freshness.financeExpensesAt),
      financeRecurringExpensesAt: instant(freshness.financeRecurringExpensesAt),
    },
    incompleteEvidence: [...ledgerGaps, ...recurringGaps].map(gap),
  };
}

// prettier-ignore
async function readTotals(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<TotalsRow>(`WITH events AS (${EVENTS}) SELECT COALESCE(sum(amount) FILTER (WHERE currency=$2 AND incurred_on BETWEEN $3::date AND $4::date),0)::text AS current,COALESCE(sum(amount) FILTER (WHERE currency=$2 AND incurred_on BETWEEN $5::date AND $6::date),0)::text AS comparison FROM events`, values.slice(0, 6))).rows[0]!; }
// prettier-ignore
async function readDaily(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<DailyRow>(`WITH events AS (${EVENTS}),dates AS (SELECT day::date FROM generate_series($3::date,$4::date,INTERVAL '1 day') day) SELECT day::text AS date,COALESCE(sum(amount) FILTER (WHERE currency=$2),0)::text AS amount FROM dates LEFT JOIN events ON incurred_on=day GROUP BY day ORDER BY day`, [values[0], values[1], values[6], values[7]])).rows; }
// prettier-ignore
async function readUpcoming(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<UpcomingRow>(`SELECT next_due_on::text AS date,amount::text FROM finance.recurring_expense_rules WHERE property_id=$1::uuid AND currency=$2 AND active AND next_due_on >= $3::date ORDER BY next_due_on,id`, [values[0], values[1], values[8]])).rows; }
// prettier-ignore
async function readFreshness(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<FreshnessRow>(`SELECT (SELECT max(updated_at)::text FROM finance.expenses WHERE property_id=$1::uuid) AS "financeExpensesAt",(SELECT max(updated_at)::text FROM finance.recurring_expense_rules WHERE property_id=$1::uuid) AS "financeRecurringExpensesAt"`, values.slice(0, 1))).rows[0]!; }
// prettier-ignore
async function readLedgerGaps(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<GapRow>(`WITH events AS (${EVENTS}) SELECT 'expense_currency_mismatch'::text AS code,count(DISTINCT id)::int AS count,sum(amount)::text AS amount,currency::text AS currency FROM events WHERE currency<>$2 AND (incurred_on BETWEEN $3::date AND $4::date OR incurred_on BETWEEN $5::date AND $6::date OR incurred_on BETWEEN $7::date AND $8::date) GROUP BY currency ORDER BY currency`, values.slice(0, 8))).rows; }
// prettier-ignore
async function readRecurringGaps(client: Pick<Client, "query">, values: readonly unknown[]) { return (await client.query<GapRow>(`SELECT 'recurring_expense_currency_mismatch'::text AS code,count(*)::int AS count,sum(amount)::text AS amount,currency::text AS currency FROM finance.recurring_expense_rules WHERE property_id=$1::uuid AND currency<>$2 AND active AND next_due_on >= $3::date GROUP BY currency ORDER BY currency`, [values[0], values[1], values[8]])).rows; }

function gap(row: GapRow): FinanceDashboardExpenseGap {
  if (
    (row.code !== "expense_currency_mismatch" &&
      row.code !== "recurring_expense_currency_mismatch") ||
    !Number.isSafeInteger(row.count) ||
    row.count < 1 ||
    !/^[A-Z]{3}$/.test(row.currency)
  )
    throw new Error("Finance Dashboard expense gap is invalid");
  return {
    code: row.code,
    count: row.count,
    amount: { amount: normalizeFinanceReportingDecimal(row.amount), currency: row.currency },
  };
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validDate(value: string): string {
  if (!localDate(value)) throw new Error("Finance Dashboard expense date is invalid");
  return value;
}
function days(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}
function instant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Finance Dashboard expense freshness is invalid");
  return parsed.toISOString();
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance Dashboard property id is malformed");
  return value.toLowerCase();
}
// prettier-ignore
async function consistentRead<T>(pool: FinanceDashboardExpenseFactsPool, read: (client: Client) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
