import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadTargetHotelBooking } from "../routes/bookingWebPublic.js";

const url = process.env.TEST_DATABASE_URL;
// VAY-2100: a host action holds the booking row while PMS adoption, which already holds the
// inventory lock, inserts assignments referencing it (FOR KEY SHARE). FOR UPDATE would make the
// two wait on each other; FOR NO KEY UPDATE lets adoption finish.
describe.skipIf(!url)("host action booking lock (PostgreSQL)", () => {
  it("lets PMS adoption reference a booking that a host action holds", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const propertyId = randomUUID(),
      bookingId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Host lock test')",
      [propertyId, propertyId],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
       VALUES($1,$2,$3,'confirmed','2026-12-01','2026-12-03','EUR')`,
      [bookingId, propertyId, bookingId],
    );
    const host = await pool.connect(),
      adoption = await pool.connect();
    try {
      for (const [mode, blocks] of [
        ["no_key", false],
        [true, true],
      ] as const) {
        await host.query("BEGIN");
        await loadTargetHotelBooking(host, propertyId, bookingId, mode);
        await adoption.query("BEGIN");
        await adoption.query("SET LOCAL lock_timeout = '1s'");
        const reference = adoption.query(
          "SELECT 1 FROM booking.guest_bookings WHERE id=$1 FOR KEY SHARE",
          [bookingId],
        );
        if (blocks) await expect(reference).rejects.toMatchObject({ code: "55P03" });
        else await expect(reference).resolves.toMatchObject({ rowCount: 1 });
        await adoption.query("ROLLBACK");
        await host.query("ROLLBACK");
      }
    } finally {
      host.release();
      adoption.release();
      await pool.query("DELETE FROM booking.guest_bookings WHERE id=$1", [bookingId]);
      await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await pool.end();
    }
  });
});
