import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financeDashboardPeriods } from "@vayada/domain-finance";

import { createPgFinanceDashboardExpenseFacts } from "./financeDashboardExpenseFacts.js";

const DB_URL = process.env["TEST_DATABASE_URL"];
const P = "11280000-0000-4000-8000-000000000201";
const EMPTY = "11280000-0000-4000-8000-000000000202";
const OTHER = "11280000-0000-4000-8000-000000000203";
const CATEGORY = "11280000-0000-4000-8000-000000000204";
const OTHER_CATEGORY = "11280000-0000-4000-8000-000000000205";
const RULES = [
  "11280000-0000-4000-8000-000000000211",
  "11280000-0000-4000-8000-000000000212",
  "11280000-0000-4000-8000-000000000213",
  "11280000-0000-4000-8000-000000000214",
];
const EXPENSES = [
  "11280000-0000-4000-8000-000000000221",
  "11280000-0000-4000-8000-000000000222",
  "11280000-0000-4000-8000-000000000223",
  "11280000-0000-4000-8000-000000000224",
  "11280000-0000-4000-8000-000000000225",
  "11280000-0000-4000-8000-000000000226",
];

// prettier-ignore
describe.skipIf(!DB_URL)("PostgreSQL Finance Dashboard expense facts", () => {
  const admin = new pg.Client({ connectionString: DB_URL ?? "postgresql://disabled" });
  const read = createPgFinanceDashboardExpenseFacts({ connectionString: DB_URL ?? "postgresql://disabled" });
  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(DB_URL!).pathname)) throw new Error("Refusing non-test database");
    await admin.connect(); await cleanup();
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO finance.expense_categories (id,property_id,name,color,sort_order,created_at,updated_at) VALUES
        ('${CATEGORY}','${P}','Operations','#112233',1,'2026-08-01T09:00:00Z','2026-08-01T09:00:00Z'),
        ('${OTHER_CATEGORY}','${OTHER}','Other','#445566',1,'2026-08-01T09:00:00Z','2026-08-01T09:00:00Z');
      INSERT INTO finance.recurring_expense_rules (id,property_id,category_id,cadence,starts_on,next_due_on,ends_on,vendor,amount,currency,payment_status,active,created_at,updated_at) VALUES
        ('${RULES[0]}','${P}','${CATEGORY}','weekly','2026-01-01','2026-08-04',NULL,'Cleaner',30,'EUR','unpaid',true,'2026-08-01T10:00:00Z','2026-08-01T10:00:00Z'),
        ('${RULES[1]}','${P}','${CATEGORY}','monthly','2026-01-01','2026-09-01',NULL,'Rent',50,'EUR','paid',true,'2026-08-01T11:00:00Z','2026-08-01T11:00:00Z'),
        ('${RULES[2]}','${P}','${CATEGORY}','monthly','2026-01-01','2026-08-05',NULL,'Dollar service',60,'USD','unpaid',true,'2026-08-01T12:00:00Z','2026-08-01T12:00:00Z'),
        ('${RULES[3]}','${P}','${CATEGORY}','weekly','2026-01-01','2026-08-06',NULL,'Disabled',70,'EUR','unpaid',false,'2026-08-01T13:00:00Z','2026-08-01T13:00:00Z');
      INSERT INTO finance.expenses (id,property_id,category_id,origin,entry_kind,incurred_on,vendor,amount,currency,payment_status,source_key,reverses_expense_id,created_at,updated_at) VALUES
        ('${EXPENSES[0]}','${P}','${CATEGORY}','manual','expense','2026-08-01','Initial',100,'EUR','unpaid',NULL,NULL,'2026-08-01T14:00:00Z','2026-08-01T14:00:00Z'),
        ('${EXPENSES[1]}','${P}','${CATEGORY}','manual','correction','2026-08-02','Corrected',80,'EUR','unpaid','v1128-correction','${EXPENSES[0]}','2026-08-02T14:00:00Z','2026-08-02T14:00:00Z'),
        ('${EXPENSES[2]}','${P}','${CATEGORY}','manual','expense','2026-08-03','Supplies',20,'EUR','unpaid',NULL,NULL,'2026-08-03T14:00:00Z','2026-08-03T14:00:00Z'),
        ('${EXPENSES[3]}','${P}','${CATEGORY}','manual','expense','2026-07-02','Prior',60,'EUR','unpaid',NULL,NULL,'2026-07-02T14:00:00Z','2026-07-02T14:00:00Z'),
        ('${EXPENSES[4]}','${P}','${CATEGORY}','manual','expense','2026-08-02','Mismatch',99,'USD','unpaid',NULL,NULL,'2026-08-02T15:00:00Z','2026-08-02T15:00:00Z'),
        ('${EXPENSES[5]}','${OTHER}','${OTHER_CATEGORY}','manual','expense','2026-08-03','Other',700,'EUR','unpaid',NULL,NULL,'2026-08-03T16:00:00Z','2026-08-03T16:00:00Z'); COMMIT`);
  });
  afterAll(async () => { await read.close(); await cleanup(); await admin.end(); });

  it("returns corrected MTD totals, zero-filled days, upcoming rules, and mismatch gaps", async () => {
    const result = await read.read(input(P));
    expect(result.totals).toEqual({ current: "100.0000", comparison: "60.0000" });
    expect(result.daily).toHaveLength(14);
    expect(result.daily.slice(-3)).toEqual([
      { date: "2026-08-01", amount: "100.0000" },
      { date: "2026-08-02", amount: "-20.0000" },
      { date: "2026-08-03", amount: "20.0000" },
    ]);
    expect(result.upcoming).toEqual([
      { date: "2026-08-04", kind: "recurring_expense", amount: "30.0000", predicted: true },
      { date: "2026-09-01", kind: "recurring_expense", amount: "50.0000", predicted: true },
    ]);
    expect(result.sourceFreshness).toEqual({ financeExpensesAt: "2026-08-03T14:00:00.000Z", financeRecurringExpensesAt: "2026-08-01T13:00:00.000Z" });
    expect(result.incompleteEvidence).toEqual([
      { code: "expense_currency_mismatch", count: 1, amount: { amount: "99.0000", currency: "USD" } },
      { code: "recurring_expense_currency_mismatch", count: 1, amount: { amount: "60.0000", currency: "USD" } },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/vendor|category|700\.0000/);
  });

  it("returns an empty zero-filled state and rejects malformed scope", async () => {
    const result = await read.read(input(EMPTY));
    expect(result).toMatchObject({ totals: { current: "0.0000", comparison: "0.0000" }, upcoming: [], sourceFreshness: { financeExpensesAt: null, financeRecurringExpensesAt: null }, incompleteEvidence: [] });
    expect(result.daily).toHaveLength(14);
    expect(result.daily.every(({ amount }) => amount === "0.0000")).toBe(true);
    await expect(read.read(input("bad"))).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ ...input(P), currency: "eur" })).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ ...input(P), daily: { from: "2026-07-22", to: "2026-08-03" } })).rejects.toBeInstanceOf(TypeError);
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${P}','${OTHER}');
      DELETE FROM finance.recurring_expense_rules WHERE property_id='${P}';
      DELETE FROM finance.expense_categories WHERE property_id IN ('${P}','${OTHER}'); COMMIT`);
  }
});

function input(propertyId: string) {
  const periods = financeDashboardPeriods("2026-08-03");
  return {
    propertyId,
    currency: "EUR",
    asOf: "2026-08-03",
    monthToDate: periods.monthToDate,
    daily: periods.daily,
  };
}
