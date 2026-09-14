import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { verifyAppliedNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillVerification.js";
import { applyNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "11810000-0000-4000-8000-000000000001";
const BOOKING = "11810000-0000-4000-8000-000000000002";
const ROOM = "11810000-0000-4000-8000-000000000003";
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
