import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceRevenueAddonFacts } from "./financeRevenueAddonFacts.js";

const DB_URL = process.env["TEST_DATABASE_URL"];
const P = "11280000-0000-4000-8000-000000000101";
const EMPTY = "11280000-0000-4000-8000-000000000102";
const OTHER = "11280000-0000-4000-8000-000000000103";
const MISMATCH_ONLY = "11280000-0000-4000-8000-000000000104";
const ROOM = "11280000-0000-4000-8000-000000000105";
const B = {
  property: "11280000-0000-4000-8000-000000000110",
  partner: "11280000-0000-4000-8000-000000000118",
  ineligible: "11280000-0000-4000-8000-000000000111",
  prior: "11280000-0000-4000-8000-000000000112",
  missing: "11280000-0000-4000-8000-000000000113",
  conflicting: "11280000-0000-4000-8000-000000000114",
  mismatch: "11280000-0000-4000-8000-000000000115",
  other: "11280000-0000-4000-8000-000000000116",
  mismatchOnly: "11280000-0000-4000-8000-000000000117",
};
const S = Object.fromEntries(
  Object.keys(B).map((key, index) => [
    key,
    `11280000-0000-4000-8000-${String(120 + index).padStart(12, "0")}`,
  ]),
) as Record<keyof typeof B, string>;
const E = Array.from(
  { length: 11 },
  (_, index) => `11280000-0000-4000-8000-${String(130 + index).padStart(12, "0")}`,
);

// prettier-ignore
describe.skipIf(!DB_URL)("PostgreSQL Finance add-on revenue facts", () => {
  const admin = new pg.Client({ connectionString: DB_URL ?? "postgresql://disabled" });
  const read = createPgFinanceRevenueAddonFacts({ connectionString: DB_URL ?? "postgresql://disabled" });
  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(DB_URL!).pathname)) throw new Error("Refusing non-test database");
    await admin.connect(); await cleanup();
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO booking.addon_revenue_evidence
        (id,addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,currency,
         gross_amount,ownership_kind,partner_commission_rate,economic_event,evidence_quality,
         source_revision,corrects_evidence_id,command_key,created_at) VALUES
        ('${E[0]}','${S.property}','${P}','${B.property}','2026-08-01',1,'EUR',100,'property',NULL,'fulfillment','exact',1,NULL,'v1128-addon-property','2026-08-01T10:00:00Z'),
        ('${E[1]}','${S.property}','${P}','${B.property}','2026-08-02',1,'EUR',-10,'property',NULL,'correction','exact',2,'${E[0]}','v1128-addon-property-correction','2026-08-02T10:00:00Z'),
        ('${E[2]}','${S.partner}','${P}','${B.property}','2026-08-02',1,'EUR',30,'partner',12.5,'fulfillment','exact',1,NULL,'v1128-addon-partner','2026-08-02T11:00:00Z'),
        ('${E[3]}','${S.partner}','${P}','${B.property}','2026-08-03',1,'EUR',-5,'partner',12.5,'correction','exact',2,'${E[2]}','v1128-addon-partner-correction','2026-08-03T11:00:00Z'),
        ('${E[4]}','${S.missing}','${P}','${B.missing}','2026-08-03',1,'EUR',NULL,'property',NULL,'missing_fulfillment','missing',1,NULL,'v1128-addon-missing','2026-08-04T12:00:00Z'),
        ('${E[5]}','${S.conflicting}','${P}','${B.conflicting}','2026-08-03',1,'EUR',NULL,'property',NULL,'missing_fulfillment','conflicting',1,NULL,'v1128-addon-conflicting','2026-08-04T13:00:00Z'),
        ('${E[6]}','${S.prior}','${P}','${B.prior}','2026-07-29',1,'EUR',80,'property',NULL,'fulfillment','exact',1,NULL,'v1128-addon-prior','2026-07-29T10:00:00Z'),
        ('${E[7]}','${S.mismatch}','${P}','${B.mismatch}','2026-08-03',1,'JPY',5,'partner',12.5,'fulfillment','exact',1,NULL,'v1128-addon-mismatch','2026-08-05T14:00:00Z'),
        ('${E[8]}','${S.other}','${OTHER}','${B.other}','2026-08-02',1,'EUR',700,'property',NULL,'fulfillment','exact',1,NULL,'v1128-addon-other','2026-08-02T12:00:00Z'),
        ('${E[9]}','${S.ineligible}','${P}','${B.ineligible}','2026-08-02',1,'EUR',50,'property',NULL,'fulfillment','exact',1,NULL,'v1128-addon-ineligible','2026-08-02T13:00:00Z'),
        ('${E[10]}','${S.mismatchOnly}','${MISMATCH_ONLY}','${B.mismatchOnly}','2026-08-02',1,'JPY',8,'property',NULL,'fulfillment','exact',1,NULL,'v1128-addon-mismatch-only','2026-08-06T15:00:00Z');
      INSERT INTO booking.nightly_revenue_evidence
        (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,
         gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,
         evidence_quality,source_revision,command_key) VALUES
        ('${P}','${B.property}','${ROOM}','2026-08-01','2026-08-01','EUR',100,1,'room_night','completed','manual','exact',1,'v1128-addon-eligible-current'),
        ('${P}','${B.prior}','${ROOM}','2026-07-29','2026-07-29','EUR',80,1,'room_night','completed','manual','exact',1,'v1128-addon-eligible-prior'),
        ('${P}','${B.mismatch}','${ROOM}','2026-08-03','2026-08-03','EUR',90,1,'room_night','completed','manual','exact',1,'v1128-addon-eligible-mismatch'); COMMIT`);
  });
  afterAll(async () => { await read.close(); await cleanup(); await admin.end(); });

  it("returns scoped ownership revenue, dated adjustments, attach facts, and evidence gaps", async () => {
    const result = await read.read({ propertyId: P.toUpperCase(), currency: "EUR", periods: periods() });
    expect(result.rows).toEqual([
      { period: "comparison", recognizedOn: "2026-07-29", ownership: "property", revenueAmount: "80.0000" },
      { period: "current", recognizedOn: "2026-08-01", ownership: "property", revenueAmount: "100.0000" },
      { period: "current", recognizedOn: "2026-08-02", ownership: "partner", revenueAmount: "3.7500" },
      { period: "current", recognizedOn: "2026-08-02", ownership: "property", revenueAmount: "40.0000" },
      { period: "current", recognizedOn: "2026-08-03", ownership: "partner", revenueAmount: "-0.6300" },
    ]);
    expect(result.fulfilledBookings).toEqual({ current: 2, comparison: 1 });
    expect(result.sourceFreshness).toEqual({ bookingAddonRevenueThrough: "2026-08-03", bookingAddonRevenueAt: "2026-08-05T14:00:00.000Z" });
    expect(result.incompleteEvidence).toEqual([
      { code: "addon_fulfillment_conflicting", count: 1 },
      { code: "addon_fulfillment_missing", count: 1 },
      { code: "addon_revenue_currency_mismatch", count: 1, currency: "JPY", amount: { amount: "1.0000", currency: "JPY" } },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/guest|bookingId|700\.0000/);
  });

  it("keeps mismatch-only freshness while excluding its money", async () => {
    await expect(read.read({ propertyId: MISMATCH_ONLY, currency: "EUR", periods: periods() })).resolves.toEqual({
      rows: [], fulfilledBookings: { current: 0, comparison: 0 },
      sourceFreshness: { bookingAddonRevenueThrough: "2026-08-02", bookingAddonRevenueAt: "2026-08-06T15:00:00.000Z" },
      incompleteEvidence: [{ code: "addon_revenue_currency_mismatch", count: 1, currency: "JPY", amount: { amount: "8.0000", currency: "JPY" } }],
    });
  });

  it("returns a zero state and rejects malformed scope", async () => {
    await expect(read.read({ propertyId: EMPTY, currency: "EUR", periods: periods() })).resolves.toEqual({ rows: [], fulfilledBookings: { current: 0, comparison: 0 }, sourceFreshness: { bookingAddonRevenueThrough: null, bookingAddonRevenueAt: null }, incompleteEvidence: [] });
    await expect(read.read({ propertyId: "bad", currency: "EUR", periods: periods() })).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ propertyId: P, currency: "eur", periods: periods() })).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ propertyId: P, currency: "EUR", periods: { current: { from: "2026-08-01", to: "2026-08-03" }, comparison: { from: "2026-07-31", to: "2026-08-01" } } })).rejects.toBeInstanceOf(TypeError);
  });

  async function cleanup() {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query("DELETE FROM booking.nightly_revenue_evidence WHERE property_id=ANY($1::uuid[])", [[P, OTHER, MISMATCH_ONLY]]);
    await admin.query("DELETE FROM booking.addon_revenue_evidence WHERE property_id=ANY($1::uuid[])", [
      [P, OTHER, MISMATCH_ONLY],
    ]);
    await admin.query("COMMIT");
  }
});

function periods() {
  return {
    current: { from: "2026-08-01", to: "2026-08-03" },
    comparison: { from: "2026-07-29", to: "2026-07-31" },
  };
}
