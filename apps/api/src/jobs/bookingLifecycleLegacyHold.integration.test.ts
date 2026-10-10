import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgBookingLifecycleStore } from "./bookingLifecycle.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
// VAY-1362 P18: the hold the migration import gives a pending booking of a hotel outside the
// cohort (packages/backend-migration productionBookingReservationRecords LEGACY_HOLD_EXPIRES_AT).
const LEGACY_HOLD = {
  expiresAt: "9999-12-31T23:59:59.999Z",
  migrationHold: "outside_migration_cohort",
};

describe.skipIf(!databaseUrl)("booking lifecycle sweep and migration-held bookings", () => {
  it("never selects a pending booking the migration holds for legacy", async () => {
    if (!databaseUrl || !/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1)))
      throw new Error("Isolated test database required");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    try {
      const propertyId = randomUUID();
      await client.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Legacy hold fixture')",
        [propertyId, `legacy-hold-${propertyId}`],
      );
      const now = new Date("2026-10-10T12:00:00.000Z");
      const createdAt = "2026-10-10T10:00:00.000Z";
      const booking = async (payment: string, metadata: Record<string, unknown>) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO booking.guest_bookings
             (id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out,
              currency,booking_metadata,created_at,updated_at)
           VALUES($1,$2,$3,'pending_payment',$4,'2026-11-01','2026-11-03','EUR',$5::jsonb,$6,$6)`,
          [
            id,
            propertyId,
            `VAY-${id.replaceAll("-", "").toUpperCase()}`,
            payment,
            metadata,
            createdAt,
          ],
        );
        return id;
      };
      const heldUnpaid = await booking("unpaid", LEGACY_HOLD);
      const heldAuthorized = await booking("authorized", LEGACY_HOLD);
      const staleUnpaid = await booking("unpaid", {});
      const expired = await booking("unpaid", { pendingExpiresAt: "2026-10-10T11:00:00.000Z" });

      const store = createPgBookingLifecycleStore({
        connectionString: databaseUrl,
        pool: client as unknown as pg.Pool,
      });
      const mine: string[] = [heldUnpaid, heldAuthorized, staleUnpaid, expired];
      const ids = (rows: Array<{ guestBookingId: string }>) =>
        rows.map((row) => row.guestBookingId).filter((id) => mine.includes(id));
      const staleBefore = new Date(now.getTime() - 30 * 60 * 1000);
      expect(ids(await store.findStaleUnpaidBookingCandidates(now, staleBefore, 10_000))).toEqual([
        staleUnpaid,
      ]);
      expect(ids(await store.findPendingBookingExpiryCandidates(now, 10_000))).toEqual([expired]);
      expect(ids(await store.findExpiredDraftCandidates(now, 10_000))).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
