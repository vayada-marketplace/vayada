import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { readUncapturedNightlyRevenueCandidates } from "./bookingNightlyRevenueBackfillReader.js";
import { verifyAppliedNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillVerification.js";
import { applyNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "11810000-0000-4000-8000-000000000001";
const BOOKING = "11810000-0000-4000-8000-000000000002";
const ROOM = "11810000-0000-4000-8000-000000000003";
const PRODUCER_BOOKING = "11810000-0000-4000-8000-000000000004";
const MIXED_BOOKING = "11810000-0000-4000-8000-000000000005";
describe.skipIf(!DATABASE_URL)("nightly revenue backfill writer (PostgreSQL)", () => {
  it("appends, replays, and corrects retained amounts without rewriting history", async () => {
    assertSafeTestDatabase(DATABASE_URL!);
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay-1181-writer','VAY-1181 writer')",
        [PROPERTY],
      );
      await client.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,
         check_in,check_out,room_count,currency,total_amount,balance_amount,booking_channel,direct_booking_source)
         VALUES($1,$2,'VAY-1181-WRITER','booking','confirmed','2026-09-14','2026-09-15',1,'EUR',100,100,'direct','booking_engine')`,
        [BOOKING, PROPERTY],
      );
      const transactionId = (await client.query("SELECT txid_current()::text id")).rows[0].id;
      const apply = (pageId: string, amount: string | null, token = transactionId) =>
        applyNightlyRevenueBackfillPage(
          client,
          {
            pageId,
            recognizedOn: "2026-09-17",
            lines: plan(amount),
          },
          token,
        );
      await expect(apply("vay1181-stale", null, "stale")).rejects.toThrow(
        "writable REPEATABLE READ transaction",
      );
      expect(await apply("vay1181-original", null)).toMatchObject({
        outcome: "appended",
        insertedCount: 1,
        sourceRevisions: { [BOOKING]: 1 },
      });
      expect(await apply("vay1181-original", null)).toMatchObject({ outcome: "replayed" });
      expect(await apply("vay1181-correction", "0.0000")).toMatchObject({
        outcome: "appended",
        insertedCount: 1,
        sourceRevisions: { [BOOKING]: 2 },
      });
      const summary = await client.query(
        `SELECT SUM(gross_room_amount)::text amount,COUNT(*)::int count,MAX(source_revision)::int revision,
         COUNT(*) FILTER(WHERE economic_event='correction' AND corrects_evidence_id IS NOT NULL)::int corrections
         FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1`,
        [BOOKING],
      );
      expect(summary.rows[0]).toEqual({
        amount: "0.0000",
        count: 2,
        revision: 2,
        corrections: 1,
      });
      expect(await verifyAppliedNightlyRevenueBackfillPage(client, plan("0.0000"))).toMatchObject({
        lineCount: 1,
        storedRows: 2,
        revisionCount: 2,
      });
      await client.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,
         check_in,check_out,room_count,currency,total_amount,balance_amount,booking_channel,direct_booking_source)
         VALUES($1,$2,'VAY-1181-PRODUCER','booking','confirmed','2026-09-14','2026-09-15',1,'EUR',15,15,'direct','booking_engine')`,
        [PRODUCER_BOOKING, PROPERTY],
      );
      await client.query(
        `INSERT INTO booking.nightly_revenue_evidence(property_id,guest_booking_id,room_type_id,
         stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,
         lifecycle_state,source_kind,evidence_quality,source_revision,line_position,command_key)
         VALUES($1,$2,$3,'2026-09-14','2026-09-14','EUR',15,1,'room_night','confirmed',
           'direct','exact',1,1,'direct-booking:producer-owned')`,
        [PROPERTY, PRODUCER_BOOKING, ROOM],
      );
      await client.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,
         check_in,check_out,room_count,currency,total_amount,balance_amount,booking_channel,direct_booking_source)
         VALUES($1,$2,'VAY-1181-MIXED','booking','confirmed','2026-09-14','2026-09-16',1,'EUR',30,30,'direct','booking_engine')`,
        [MIXED_BOOKING, PROPERTY],
      );
      await client.query(
        `INSERT INTO booking.nightly_revenue_evidence(property_id,guest_booking_id,room_type_id,
         stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,
         lifecycle_state,source_kind,evidence_quality,source_revision,line_position,command_key)
         VALUES
           ($1,$2,$3,'2026-09-14','2026-09-14','EUR',15,1,'room_night','confirmed','direct','exact',1,1,'backfill:v1:mixed'),
           ($1,$2,$3,'2026-09-15','2026-09-15','EUR',15,1,'room_night','confirmed','direct','exact',1,1,'direct-booking:mixed')`,
        [PROPERTY, MIXED_BOOKING, ROOM],
      );
      const correctionPage = await readUncapturedNightlyRevenueCandidates(client, { limit: 10 });
      expect(correctionPage.candidates.map(({ guestBookingId }) => guestBookingId)).toEqual([
        BOOKING,
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});
function plan(grossRoomAmount: string | null) {
  const line = {
    propertyId: PROPERTY,
    guestBookingId: BOOKING,
    roomTypeId: ROOM,
    stayDate: "2026-09-14",
    currency: "EUR",
    grossRoomAmount,
    linePosition: 1,
    lifecycleState: "confirmed",
    sourceKind: "direct",
    evidenceQuality: grossRoomAmount === null ? "missing" : "exact",
  } as const;
  const evidenceFingerprint = createHash("sha256")
    .update(JSON.stringify([line]))
    .digest("hex");
  return [{ ...line, evidenceFingerprint }];
}
