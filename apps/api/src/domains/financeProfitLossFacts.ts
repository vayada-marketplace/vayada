import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  financeProfitLossExpenseCategoryRow,
  normalizeFinanceReportingDecimal,
  type FinanceReportingComparison,
  type FinanceReportingIncompleteEvidence,
} from "@vayada/domain-finance";

import type { FinanceProfitLossResponseInput } from "./financeProfitLossResponse.js";
import {
  readFinanceRevenueAddonFacts,
  type FinanceRevenueAddonGap,
} from "./financeRevenueAddonFacts.js";
import {
  readFinanceRevenueRoomFacts,
  type FinanceRevenueRoomGap,
} from "./financeRevenueRoomFacts.js";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
export type FinanceProfitLossFactsPool = Pick<Client, "query"> & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};
export type FinanceProfitLossFacts = Pick<
  FinanceProfitLossResponseInput,
  | "categoryRows"
  | "roomRevenue"
  | "upsellRevenue"
  | "expenses"
  | "sourceFreshness"
  | "incompleteEvidence"
>;
export type FinanceProfitLossFactsReadPort = {
  read(input: {
    propertyId: string;
    currency: string;
    periods: FinanceReportingComparison;
  }): Promise<FinanceProfitLossFacts>;
  close(): Promise<void>;
};

type CategoryRow = { id: string; systemKey: string | null; updatedAt: string };
type ExpenseRow = {
  period: string;
  incurredOn: string;
  categoryId: string;
  amount: string;
};
type ExpenseGapRow = { count: number; amount: string; currency: string };
type FreshnessRow = { financeExpensesAt: string | null };
type Gap = FinanceRevenueRoomGap | FinanceRevenueAddonGap;
const EVENTS = `SELECT e.id,e.category_id,e.incurred_on,e.currency,CASE WHEN e.entry_kind='reversal' THEN -e.amount ELSE e.amount END AS amount FROM finance.expenses e WHERE e.property_id=$1::uuid UNION ALL SELECT correction.id,prior.category_id,correction.incurred_on,prior.currency,-prior.amount FROM finance.expenses correction JOIN finance.expenses prior ON prior.id=correction.reverses_expense_id AND prior.property_id=correction.property_id WHERE correction.property_id=$1::uuid AND correction.entry_kind='correction'`;

export function createPgFinanceProfitLossFacts(config: {
  connectionString?: string;
  pool?: FinanceProfitLossFactsPool;
  max?: number;
}): FinanceProfitLossFactsReadPort {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance profit and loss facts require a connection string");
  const ownsPool = !config.pool;
  const pool: FinanceProfitLossFactsPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async read(input) {
      return consistentRead(pool, async (client) => {
        const rooms = await readFinanceRevenueRoomFacts(client, input);
        const addOns = await readFinanceRevenueAddonFacts(client, input);
        const categories = await readCategories(client, input.propertyId);
        const categoryById = new Map(categories.map((row) => [row.id, row]));
        const expenseRows = await readExpenses(client, input);
        const expenseGaps = await readExpenseGaps(client, input);
        const expenseFreshness = await readExpenseFreshness(client, input.propertyId);
        return {
          categoryRows: categories.map(financeProfitLossExpenseCategoryRow),
          roomRevenue: rooms.rows.map(({ period, recognizedOn, grossRoomAmount }) => ({
            period,
            recognizedOn,
            amount: grossRoomAmount,
          })),
          upsellRevenue: addOns.rows.map(({ period, recognizedOn, revenueAmount }) => ({
            period,
            recognizedOn,
            amount: revenueAmount,
          })),
          expenses: expenseRows.map((row) => {
            const category = categoryById.get(row.categoryId);
            if (!category) throw new Error("Finance profit and loss category evidence is missing");
            if (row.period !== "current" && row.period !== "comparison")
              throw new Error("Finance profit and loss expense period is invalid");
            return {
              period: row.period,
              incurredOn: row.incurredOn,
              categoryRow: financeProfitLossExpenseCategoryRow(category),
              amount: normalizeFinanceReportingDecimal(row.amount),
            };
          }),
          sourceFreshness: compact({
            ...rooms.sourceFreshness,
            ...addOns.sourceFreshness,
            financeExpensesAt: instant(expenseFreshness.financeExpensesAt),
            financeCategoriesAt: latest(categories.map((row) => row.updatedAt)),
          }),
          incompleteEvidence: [
            ...rooms.incompleteEvidence.map(incomplete),
            ...addOns.incompleteEvidence.map(incomplete),
            ...expenseGaps.map((row) => ({
              code: "expense_currency_mismatch",
              count: row.count,
              amount: {
                amount: normalizeFinanceReportingDecimal(row.amount),
                currency: row.currency,
              },
            })),
          ],
        };
      });
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

async function readCategories(client: Pick<Client, "query">, propertyId: string) {
  return (
    await client.query<CategoryRow>(
      `SELECT id::text,system_key AS "systemKey",updated_at::text AS "updatedAt" FROM finance.expense_categories WHERE property_id=$1::uuid ORDER BY id`,
      [propertyId],
    )
  ).rows;
}
async function readExpenses(
  client: Pick<Client, "query">,
  input: { propertyId: string; currency: string; periods: FinanceReportingComparison },
) {
  return (
    await client.query<ExpenseRow>(
      `WITH events AS (${EVENTS}) SELECT CASE WHEN incurred_on BETWEEN $3::date AND $4::date THEN 'current' ELSE 'comparison' END AS period,incurred_on::text AS "incurredOn",category_id::text AS "categoryId",sum(amount)::text AS amount FROM events WHERE currency=$2 AND (incurred_on BETWEEN $3::date AND $4::date OR incurred_on BETWEEN $5::date AND $6::date) GROUP BY period,incurred_on,category_id ORDER BY period,incurred_on,category_id`,
      values(input),
    )
  ).rows;
}
async function readExpenseGaps(
  client: Pick<Client, "query">,
  input: { propertyId: string; currency: string; periods: FinanceReportingComparison },
) {
  return (
    await client.query<ExpenseGapRow>(
      `WITH events AS (${EVENTS}) SELECT count(DISTINCT id)::int AS count,sum(amount)::text AS amount,currency::text FROM events WHERE currency<>$2 AND (incurred_on BETWEEN $3::date AND $4::date OR incurred_on BETWEEN $5::date AND $6::date) GROUP BY currency ORDER BY currency`,
      values(input),
    )
  ).rows;
}
async function readExpenseFreshness(client: Pick<Client, "query">, propertyId: string) {
  return (
    await client.query<FreshnessRow>(
      `SELECT max(updated_at)::text AS "financeExpensesAt" FROM finance.expenses WHERE property_id=$1::uuid`,
      [propertyId],
    )
  ).rows[0]!;
}
function values(input: {
  propertyId: string;
  currency: string;
  periods: FinanceReportingComparison;
}) {
  return [
    input.propertyId,
    input.currency,
    input.periods.current.from,
    input.periods.current.to,
    input.periods.comparison.from,
    input.periods.comparison.to,
  ];
}
function incomplete(value: Gap): FinanceReportingIncompleteEvidence {
  if ("amount" in value && value.amount)
    return { code: value.code, count: value.count, amount: value.amount };
  return "currency" in value
    ? { code: value.code, count: value.count, currency: value.currency }
    : { code: value.code, count: value.count };
}
function compact(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
function instant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Finance freshness is invalid");
  return parsed.toISOString();
}
function latest(values: string[]): string | null {
  return values.length ? instant(values.sort().at(-1)!) : null;
}
// prettier-ignore
async function consistentRead<T>(pool: FinanceProfitLossFactsPool, read: (client: Client) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
