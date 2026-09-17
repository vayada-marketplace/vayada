import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceRevenueRoomFacts } from "./financeRevenueRoomFacts.js";

const DB_URL = process.env["TEST_DATABASE_URL"];
const P = "11280000-0000-4000-8000-000000000001";
const EMPTY = "11280000-0000-4000-8000-000000000002";
const OTHER = "11280000-0000-4000-8000-000000000003";
const ROOM = "11280000-0000-4000-8000-000000000010";
const ROOM_TWO = "11280000-0000-4000-8000-000000000011";
const RULE = "11280000-0000-4000-8000-000000000012";
const B = {
  direct: "11280000-0000-4000-8000-000000000020",
  ota: "11280000-0000-4000-8000-000000000021",
  unknown: "11280000-0000-4000-8000-000000000022",
  prior: "11280000-0000-4000-8000-000000000023",
  missing: "11280000-0000-4000-8000-000000000024",
  mismatch: "11280000-0000-4000-8000-000000000025",
  other: "11280000-0000-4000-8000-000000000026",
  mismatchMissing: "11280000-0000-4000-8000-000000000027",
};
const E = {
  direct: "11280000-0000-4000-8000-000000000030",
  correction: "11280000-0000-4000-8000-000000000031",
  ota: "11280000-0000-4000-8000-000000000032",
  unknown: "11280000-0000-4000-8000-000000000033",
  prior: "11280000-0000-4000-8000-000000000034",
  missing: "11280000-0000-4000-8000-000000000035",
  mismatch: "11280000-0000-4000-8000-000000000036",
  other: "11280000-0000-4000-8000-000000000037",
  mismatchMissing: "11280000-0000-4000-8000-000000000038",
};

// prettier-ignore
describe.skipIf(!DB_URL)("PostgreSQL Finance room-revenue facts", () => {
  const admin = new pg.Client({ connectionString: DB_URL ?? "postgresql://disabled" });
  const read = createPgFinanceRevenueRoomFacts({ connectionString: DB_URL ?? "postgresql://disabled" });
  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(DB_URL!).pathname)) throw new Error("Refusing non-test database");
    await admin.connect(); await cleanup();
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO booking.guest_bookings (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,currency,booking_channel,direct_booking_source) VALUES
        ('${B.direct}','${P}','v1128-direct','pms','v1128-direct','confirmed','2026-07-01','2026-09-01','EUR','direct','email'),
        ('${B.ota}','${P}','v1128-ota','pms','v1128-ota','confirmed','2026-07-01','2026-09-01','EUR','booking_com',NULL),
        ('${B.unknown}','${P}','v1128-unknown','pms','v1128-unknown','confirmed','2026-07-01','2026-09-01','EUR','unknown',NULL),
        ('${B.prior}','${P}','v1128-prior','pms','v1128-prior','completed','2026-07-01','2026-09-01','EUR','direct','email'),
        ('${B.missing}','${P}','v1128-missing','pms','v1128-missing','confirmed','2026-07-01','2026-09-01','EUR','booking_com',NULL),
        ('${B.mismatch}','${P}','v1128-mismatch','pms','v1128-mismatch','confirmed','2026-07-01','2026-09-01','USD','direct','call'),
        ('${B.mismatchMissing}','${P}','v1128-mismatch-missing','pms','v1128-mismatch-missing','confirmed','2026-07-01','2026-09-01','GBP','direct','call'),
        ('${B.other}','${OTHER}','v1128-other','pms','v1128-other','confirmed','2026-07-01','2026-09-01','EUR','direct','walk_in');
      INSERT INTO booking.nightly_revenue_evidence (id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,command_key,corrects_evidence_id) VALUES
        ('${E.direct}','${P}','${B.direct}','${ROOM}','2026-08-01','2026-08-01','EUR',100,1,'room_night','confirmed','direct','exact',1,'v1128-direct',NULL),
        ('${E.correction}','${P}','${B.direct}','${ROOM}','2026-08-01','2026-08-02','EUR',-10,0,'correction','corrected','direct','exact',2,'v1128-correction','${E.direct}'),
        ('${E.ota}','${P}','${B.ota}','${ROOM}','2026-08-02','2026-08-02','EUR',200,1,'room_night','confirmed','ota','exact',1,'v1128-ota',NULL),
        ('${E.unknown}','${P}','${B.unknown}','${ROOM_TWO}','2026-08-03','2026-08-03','EUR',50,1,'room_night','confirmed','migration','exact',1,'v1128-unknown',NULL),
        ('${E.prior}','${P}','${B.prior}','${ROOM}','2026-07-29','2026-07-29','EUR',80,1,'room_night','completed','direct','exact',1,'v1128-prior',NULL),
        ('${E.missing}','${P}','${B.missing}','${ROOM_TWO}','2026-08-03','2026-08-03','EUR',NULL,1,'room_night','confirmed','ota','missing',1,'v1128-missing',NULL),
        ('${E.mismatch}','${P}','${B.mismatch}','${ROOM}','2026-08-02','2026-08-02','USD',999,1,'room_night','confirmed','direct','exact',1,'v1128-mismatch',NULL),
        ('${E.mismatchMissing}','${P}','${B.mismatchMissing}','${ROOM}','2026-08-02','2026-08-02','GBP',NULL,1,'room_night','confirmed','direct','missing',1,'v1128-mismatch-missing',NULL),
        ('${E.other}','${OTHER}','${B.other}','${ROOM}','2026-08-02','2026-08-02','EUR',700,1,'room_night','confirmed','direct','exact',1,'v1128-other',NULL);
      INSERT INTO finance.ota_commission_evidence (id,booking_revenue_evidence_id,property_id,guest_booking_id,service_night,channel,currency,gross_room_amount,commission_rule_id,commission_rule_revision,percentage_rate,commission_amount,evidence_state,created_at) VALUES
        ('11280000-0000-4000-8000-000000000040','${E.ota}','${P}','${B.ota}','2026-08-02','booking_com','EUR',200,'${RULE}',1,15,30,'applied','2026-08-04T12:00:00Z'),
        ('11280000-0000-4000-8000-000000000041','${E.missing}','${P}','${B.missing}','2026-08-03','booking_com','EUR',NULL,'${RULE}',1,15,NULL,'missing_gross','2026-08-04T13:00:00Z'); COMMIT`);
  });
  afterAll(async () => { await read.close(); await cleanup(); await admin.end(); });

  it("returns scoped facts, corrections, unknown attribution, and explicit evidence gaps", async () => {
    const result = await read.read({ propertyId: P.toUpperCase(), currency: "EUR", periods: periods() });
    expect(result.rows).toEqual(expect.arrayContaining([
      { period: "current", recognizedOn: "2026-08-01", channel: "direct", directSource: "email", roomTypeId: ROOM, grossRoomAmount: "100.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
      { period: "current", recognizedOn: "2026-08-02", channel: "direct", directSource: "email", roomTypeId: ROOM, grossRoomAmount: "-10.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 0, pricedOccupiedRoomNights: 0 },
      { period: "current", recognizedOn: "2026-08-02", channel: "booking_com", directSource: null, roomTypeId: ROOM, grossRoomAmount: "200.0000", otaCommissionAmount: "30.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
      { period: "current", recognizedOn: "2026-08-03", channel: "booking_com", directSource: null, roomTypeId: ROOM_TWO, grossRoomAmount: "0.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 0 },
      { period: "current", recognizedOn: "2026-08-03", channel: "unknown", directSource: null, roomTypeId: ROOM_TWO, grossRoomAmount: "50.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
      { period: "comparison", recognizedOn: "2026-07-29", channel: "direct", directSource: "email", roomTypeId: ROOM, grossRoomAmount: "80.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
    ]));
    expect(result.eligibleBookings).toEqual({ current: 6, comparison: 1 });
    expect(result.sourceFreshness).toEqual({ bookingRevenueThrough: "2026-08-03", financeOtaCommissionAt: "2026-08-04T13:00:00.000Z" });
    expect(result.incompleteEvidence).toEqual([
      { code: "ota_commission_missing", count: 1 },
      { code: "room_revenue_currency_mismatch", count: 1, currency: "GBP" },
      { code: "room_revenue_currency_mismatch", count: 1, currency: "USD", amount: { amount: "999.0000", currency: "USD" } },
      { code: "room_revenue_missing", count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/guest|bookingId|700\.0000/);
  });

  it("treats missing room prices as known after same-day or later exact corrections", async () => {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO booking.guest_bookings (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,currency,booking_channel) VALUES
        ('11280000-0000-4000-8000-000000000050','${P}','v1128-same-day','pms','v1128-same-day','confirmed','2026-08-02','2026-08-03','EUR','agoda'),
        ('11280000-0000-4000-8000-000000000051','${P}','v1128-later','pms','v1128-later','confirmed','2026-08-01','2026-08-02','EUR','airbnb');
      INSERT INTO booking.nightly_revenue_evidence (id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,command_key,corrects_evidence_id) VALUES
        ('11280000-0000-4000-8000-000000000052','${P}','11280000-0000-4000-8000-000000000050','${ROOM_TWO}','2026-08-02','2026-08-02','EUR',NULL,1,'room_night','confirmed','ota','missing',1,'v1128-same-day-base',NULL),
        ('11280000-0000-4000-8000-000000000053','${P}','11280000-0000-4000-8000-000000000050','${ROOM_TWO}','2026-08-02','2026-08-02','EUR',125,0,'correction','corrected','ota','exact',2,'v1128-same-day-correction','11280000-0000-4000-8000-000000000052'),
        ('11280000-0000-4000-8000-000000000054','${P}','11280000-0000-4000-8000-000000000051','${ROOM_TWO}','2026-08-01','2026-08-01','EUR',NULL,1,'room_night','confirmed','ota','missing',1,'v1128-later-base',NULL),
        ('11280000-0000-4000-8000-000000000055','${P}','11280000-0000-4000-8000-000000000051','${ROOM_TWO}','2026-08-01','2026-08-03','EUR',80,0,'correction','corrected','ota','exact',2,'v1128-later-correction','11280000-0000-4000-8000-000000000054'); COMMIT`);

    const result = await read.read({ propertyId: P, currency: "EUR", periods: periods() });

    expect(result.rows).toEqual(expect.arrayContaining([
      { period: "current", recognizedOn: "2026-08-02", channel: "agoda", directSource: null, roomTypeId: ROOM_TWO, grossRoomAmount: "125.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
      { period: "current", recognizedOn: "2026-08-01", channel: "airbnb", directSource: null, roomTypeId: ROOM_TWO, grossRoomAmount: "0.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 1, pricedOccupiedRoomNights: 1 },
      { period: "current", recognizedOn: "2026-08-03", channel: "airbnb", directSource: null, roomTypeId: ROOM_TWO, grossRoomAmount: "80.0000", otaCommissionAmount: "0.0000", occupiedRoomNights: 0, pricedOccupiedRoomNights: 0 },
    ]));
    expect(result.incompleteEvidence).toContainEqual({ code: "room_revenue_missing", count: 2 });
  });

  it("returns a zero state and rejects malformed scope", async () => {
    await expect(read.read({ propertyId: EMPTY, currency: "EUR", periods: periods() })).resolves.toEqual({ rows: [], eligibleBookings: { current: 0, comparison: 0 }, sourceFreshness: { bookingRevenueThrough: null, financeOtaCommissionAt: null }, incompleteEvidence: [] });
    await expect(read.read({ propertyId: "bad", currency: "EUR", periods: periods() })).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ propertyId: P, currency: "eur", periods: periods() })).rejects.toBeInstanceOf(TypeError);
    await expect(read.read({ propertyId: P, currency: "EUR", periods: { current: { from: "2026-08-01", to: "2026-08-03" }, comparison: { from: "2026-07-31", to: "2026-08-01" } } })).rejects.toBeInstanceOf(TypeError);
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.ota_commission_evidence WHERE property_id IN ('${P}','${OTHER}');
      DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN ('${P}','${OTHER}');
      DELETE FROM booking.guest_bookings WHERE property_id IN ('${P}','${OTHER}'); COMMIT`);
  }
});

function periods() {
  return {
    current: { from: "2026-08-01", to: "2026-08-03" },
    comparison: { from: "2026-07-29", to: "2026-07-31" },
  };
}
