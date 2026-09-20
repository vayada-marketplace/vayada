import pg, { type QueryResult, type QueryResultRow } from "pg";

import { readFinanceDashboardExpenseFacts } from "./financeDashboardExpenseFacts.js";
import type { FinanceDashboardFactsReadPort } from "./financeDashboardReadModel.js";
import { readFinanceRevenueAddonFacts } from "./financeRevenueAddonFacts.js";
import { readFinanceRevenueRoomFacts } from "./financeRevenueRoomFacts.js";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
export type FinanceDashboardFactsPool = Pick<Client, "query"> & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};
export type PgFinanceDashboardFactsReadPort = FinanceDashboardFactsReadPort & {
  close(): Promise<void>;
};

export function createPgFinanceDashboardFacts(config: {
  connectionString?: string;
  pool?: FinanceDashboardFactsPool;
  max?: number;
}): PgFinanceDashboardFactsReadPort {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance Dashboard facts require a connection string");
  const ownsPool = !config.pool;
  const pool: FinanceDashboardFactsPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  return {
    async readConsistent(input) {
      return consistentRead(pool, async (client) => {
        return {
          rooms: await readFinanceRevenueRoomFacts(client, input.revenue),
          addOns: await readFinanceRevenueAddonFacts(client, input.revenue),
          expenses: await readFinanceDashboardExpenseFacts(client, input.expenses),
        };
      });
    },
    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

// prettier-ignore
async function consistentRead<T>(pool: FinanceDashboardFactsPool, read: (client: Client) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
