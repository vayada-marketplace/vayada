import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financeDashboardPeriods } from "@vayada/domain-finance";

import {
  createPgFinanceDashboardFacts,
  type FinanceDashboardFactsPool,
} from "./financeDashboardFacts.js";

const DB_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "11280000-0000-4000-8000-000000000301";
const CATEGORY = "11280000-0000-4000-8000-000000000302";
const EXPENSE = "11280000-0000-4000-8000-000000000303";
const LATE_EXPENSE = "11280000-0000-4000-8000-000000000304";

// prettier-ignore
describe.skipIf(!DB_URL)("PostgreSQL Finance Dashboard consistent facts", () => {
  const base = new pg.Pool({ connectionString: DB_URL });
  const admin = new pg.Client({ connectionString: DB_URL ?? "postgresql://disabled" });
  let writerCommitted = false;
  const pool: FinanceDashboardFactsPool = {
    query: <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<Pick<QueryResult<T>, "rows">> => base.query<T>(sql, values as unknown[] | undefined),
    async connect() {
      const client = await base.connect();
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<T>, "rows">> {
          const result = await client.query<T>(sql, values as unknown[] | undefined);
          if (!writerCommitted && sql.includes('AS "grossRoomAmount"')) {
            await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
              INSERT INTO finance.expenses (id,property_id,category_id,origin,entry_kind,incurred_on,vendor,amount,currency,payment_status)
              VALUES ('${LATE_EXPENSE}','${PROPERTY}','${CATEGORY}','manual','expense','2026-08-03','After',90,'EUR','unpaid'); COMMIT`);
            writerCommitted = true;
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  const facts = createPgFinanceDashboardFacts({ pool });

  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(DB_URL!).pathname)) throw new Error("Refusing non-test database");
    await admin.connect(); await cleanup();
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO finance.expense_categories (id,property_id,name,color,sort_order) VALUES ('${CATEGORY}','${PROPERTY}','Snapshot','#112233',1);
      INSERT INTO finance.expenses (id,property_id,category_id,origin,entry_kind,incurred_on,vendor,amount,currency,payment_status)
      VALUES ('${EXPENSE}','${PROPERTY}','${CATEGORY}','manual','expense','2026-08-03','Before',10,'EUR','unpaid'); COMMIT`);
  });
  afterAll(async () => { await facts.close(); await cleanup(); await admin.end(); await base.end(); });

  it("keeps later facts on the room-read snapshot when a writer commits between reads", async () => {
    const periods = financeDashboardPeriods("2026-08-03");
    const result = await facts.readConsistent({
      revenue: {
        propertyId: PROPERTY,
        currency: "EUR",
        periods: { current: periods.daily, comparison: periods.monthToDate.comparison },
      },
      expenses: {
        propertyId: PROPERTY,
        currency: "EUR",
        asOf: "2026-08-03",
        monthToDate: periods.monthToDate,
        daily: periods.daily,
      },
    });
    expect(writerCommitted).toBe(true);
    expect(result.expenses.totals.current).toBe("10.0000");
    await expect(admin.query("SELECT sum(amount)::text AS amount FROM finance.expenses WHERE property_id=$1", [PROPERTY])).resolves.toMatchObject({ rows: [{ amount: "100.0000" }] });
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE id IN ('${EXPENSE}','${LATE_EXPENSE}');
      DELETE FROM finance.expense_categories WHERE id='${CATEGORY}'; COMMIT`);
  }
});
