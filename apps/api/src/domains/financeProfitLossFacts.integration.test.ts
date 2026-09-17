import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceProfitLossFacts } from "./financeProfitLossFacts.js";
import { composeFinanceProfitLossResponse } from "./financeProfitLossResponse.js";

const DB_URL = process.env["TEST_DATABASE_URL"];
const P = "11310000-0000-4000-8000-000000000001";
const OTHER = "11310000-0000-4000-8000-000000000002";
const STAFF = "11310000-0000-4000-8000-000000000003";
const CUSTOM = "11310000-0000-4000-8000-000000000004";
const OTHER_CATEGORY = "11310000-0000-4000-8000-000000000005";
const ROOM = "11310000-0000-4000-8000-000000000006";
const BOOKINGS = [
  "11310000-0000-4000-8000-000000000011",
  "11310000-0000-4000-8000-000000000012",
  "11310000-0000-4000-8000-000000000013",
];
const EXPENSES = [
  "11310000-0000-4000-8000-000000000021",
  "11310000-0000-4000-8000-000000000022",
  "11310000-0000-4000-8000-000000000023",
  "11310000-0000-4000-8000-000000000024",
  "11310000-0000-4000-8000-000000000025",
];

// prettier-ignore
describe.skipIf(!DB_URL)("PostgreSQL Finance profit and loss facts", () => {
  const admin = new pg.Client({ connectionString: DB_URL ?? "postgresql://disabled" });
  const read = createPgFinanceProfitLossFacts({ connectionString: DB_URL ?? "postgresql://disabled" });

  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(DB_URL!).pathname)) throw new Error("Refusing non-test database");
    await admin.connect(); await cleanup();
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO booking.guest_bookings (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,currency,booking_channel,direct_booking_source) VALUES
        ('${BOOKINGS[0]}','${P}','v1131-current','pms','v1131-current','completed','2026-01-01','2026-04-01','EUR','direct','email'),
        ('${BOOKINGS[1]}','${P}','v1131-prior','pms','v1131-prior','completed','2025-01-01','2025-04-01','EUR','direct','email'),
        ('${BOOKINGS[2]}','${OTHER}','v1131-other','pms','v1131-other','completed','2026-01-01','2026-04-01','EUR','direct','email');
      INSERT INTO booking.nightly_revenue_evidence (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,command_key) VALUES
        ('${P}','${BOOKINGS[0]}','${ROOM}','2026-01-10','2026-01-10','EUR',100,1,'room_night','completed','manual','exact',1,'v1131-room-current'),
        ('${P}','${BOOKINGS[1]}','${ROOM}','2025-01-10','2025-01-10','EUR',80,1,'room_night','completed','manual','exact',1,'v1131-room-prior'),
        ('${OTHER}','${BOOKINGS[2]}','${ROOM}','2026-01-10','2026-01-10','EUR',700,1,'room_night','completed','manual','exact',1,'v1131-room-other');
      INSERT INTO booking.addon_revenue_evidence (addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,currency,gross_amount,ownership_kind,economic_event,evidence_quality,source_revision,command_key,created_at) VALUES
        ('11310000-0000-4000-8000-000000000031','${P}','${BOOKINGS[0]}','2026-01-11',1,'EUR',20,'property','fulfillment','exact',1,'v1131-addon-current','2026-01-11T10:00:00Z'),
        ('11310000-0000-4000-8000-000000000032','${P}','${BOOKINGS[1]}','2025-01-11',1,'EUR',10,'property','fulfillment','exact',1,'v1131-addon-prior','2025-01-11T10:00:00Z'),
        ('11310000-0000-4000-8000-000000000033','${OTHER}','${BOOKINGS[2]}','2026-01-11',1,'EUR',700,'property','fulfillment','exact',1,'v1131-addon-other','2026-01-11T10:00:00Z');
      INSERT INTO finance.expense_categories(id,property_id,system_key,name,color,archived_at,updated_at) VALUES
        ('${STAFF}','${P}','staff','Staff','#111111',NULL,'2026-03-17T08:00:00Z'),
        ('${CUSTOM}','${P}',NULL,'Historic','#222222','2026-03-01T00:00:00Z','2026-03-17T09:00:00Z'),
        ('${OTHER_CATEGORY}','${OTHER}',NULL,'Other','#333333',NULL,'2026-03-17T10:00:00Z');
      INSERT INTO finance.expenses(id,property_id,category_id,origin,entry_kind,incurred_on,vendor,amount,currency,payment_status,updated_at) VALUES
        ('${EXPENSES[0]}','${P}','${STAFF}','manual','expense','2026-01-12','Staff',30,'EUR','unpaid','2026-01-12T10:00:00Z'),
        ('${EXPENSES[1]}','${P}','${CUSTOM}','manual','expense','2026-01-13','Historic',5,'EUR','unpaid','2026-01-13T10:00:00Z'),
        ('${EXPENSES[2]}','${P}','${STAFF}','manual','expense','2025-01-12','Prior',20,'EUR','unpaid','2025-01-12T10:00:00Z'),
        ('${EXPENSES[3]}','${P}','${STAFF}','manual','expense','2026-01-14','Mismatch',99,'USD','unpaid','2026-01-14T10:00:00Z'),
        ('${EXPENSES[4]}','${OTHER}','${OTHER_CATEGORY}','manual','expense','2026-01-12','Other',700,'EUR','unpaid','2026-01-12T10:00:00Z'); COMMIT`);
  });
  afterAll(async () => { await read.close(); await cleanup(); await admin.end(); });

  it("reads revenue and expense evidence from one property-scoped snapshot", async () => {
    const result = await read.read({ propertyId: P, currency: "EUR", periods: periods() });
    expect(result.roomRevenue).toEqual([{ period: "comparison", recognizedOn: "2025-01-10", amount: "80.0000" }, { period: "current", recognizedOn: "2026-01-10", amount: "100.0000" }]);
    expect(result.upsellRevenue).toEqual([{ period: "comparison", recognizedOn: "2025-01-11", amount: "10.0000" }, { period: "current", recognizedOn: "2026-01-11", amount: "20.0000" }]);
    expect(result.categoryRows).toEqual(["staff", `custom:${CUSTOM}`]);
    expect(result.expenses).toEqual([{ period: "comparison", incurredOn: "2025-01-12", categoryRow: "staff", amount: "20.0000" }, { period: "current", incurredOn: "2026-01-12", categoryRow: "staff", amount: "30.0000" }, { period: "current", incurredOn: "2026-01-13", categoryRow: `custom:${CUSTOM}`, amount: "5.0000" }]);
    expect(result.incompleteEvidence).toContainEqual({ code: "expense_currency_mismatch", count: 1, amount: { amount: "99.0000", currency: "USD" } });
    expect(result.sourceFreshness).toMatchObject({ financeExpensesAt: "2026-01-14T10:00:00.000Z", financeCategoriesAt: "2026-03-17T09:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("700.0000");
    const response = composeFinanceProfitLossResponse({ ...result, propertyId: P, currency: "EUR", timeZone: "Europe/Berlin", generatedAt: "2026-03-17T10:00:00.000Z", asOf: "2026-03-17", query: { year: 2026 } });
    expect(response.months[0]).toMatchObject({ revenue: { amount: "120.0000" }, expenses: { amount: "35.0000" }, netProfit: { amount: "85.0000" } });
    expect(response.summary).toMatchObject({ revenueYtd: { value: { amount: "120.0000" }, absoluteChange: { amount: "30.0000" } }, expensesYtd: { value: { amount: "35.0000" }, absoluteChange: { amount: "15.0000" } }, netProfitYtd: { value: { amount: "85.0000" }, absoluteChange: { amount: "15.0000" } } });
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${P}','${OTHER}'); DELETE FROM finance.expense_categories WHERE property_id IN ('${P}','${OTHER}');
      DELETE FROM booking.addon_revenue_evidence WHERE property_id IN ('${P}','${OTHER}'); DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN ('${P}','${OTHER}'); DELETE FROM booking.guest_bookings WHERE property_id IN ('${P}','${OTHER}'); COMMIT`);
  }
});

function periods() {
  return {
    current: { from: "2026-01-01", to: "2026-03-17" },
    comparison: { from: "2025-01-01", to: "2025-03-17" },
  };
}
