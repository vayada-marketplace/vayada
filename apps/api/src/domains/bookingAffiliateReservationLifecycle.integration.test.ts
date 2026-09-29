import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createPgBookingLifecycleStore,
  runBookingLifecycleSchedulerJobs,
} from "../jobs/bookingLifecycle.js";
import { publishAffiliateReservationLifecycle as publish } from "./bookingAffiliateReservationLifecycle.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("affiliate reservation lifecycle publication", () => {
  it("publishes ordered live evidence once and ignores synthetic, unbound, and rolled-back evidence", async () => {
    if (!databaseUrl || !/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1)))
      throw new Error("Isolated test database required");
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    const propertyId = randomUUID();
    const liveBookingId = randomUUID();
    const liveContextId = randomUUID();
    const syntheticBookingId = randomUUID();
    const syntheticContextId = randomUUID();
    const unboundBookingId = randomUUID();
    const roomTypeId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    try {
      await client.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Affiliate lifecycle fixture')",
        [propertyId, `affiliate-${suffix}`],
      );
      await client.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Berlin')",
        [propertyId],
      );
      for (const bookingId of [liveBookingId, syntheticBookingId, unboundBookingId])
        await client.query(
          `INSERT INTO booking.guest_bookings
             (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
           VALUES($1,$2,$3,'confirmed','2026-10-01','2026-10-03','EUR')`,
          [bookingId, propertyId, `VAY-${bookingId.replaceAll("-", "").toUpperCase()}`],
        );
      await client.query(
        "INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic) VALUES($1,$3,FALSE),($2,$3,TRUE)",
        [liveContextId, syntheticContextId, propertyId],
      );
      await client.query(
        `INSERT INTO booking.affiliate_original_booking_bindings
           (booking_id,property_id,context_id,history_cutoff,original_public_reference,
            original_check_in,original_check_out,original_currency,synthetic)
         SELECT id,property_id,$2,0,public_reference,check_in,check_out,currency,$3
         FROM booking.guest_bookings WHERE id=$1`,
        [liveBookingId, liveContextId, false],
      );
      await client.query(
        `INSERT INTO booking.affiliate_original_booking_bindings
           (booking_id,property_id,context_id,history_cutoff,original_public_reference,
            original_check_in,original_check_out,original_currency,synthetic)
         SELECT id,property_id,$2,0,public_reference,check_in,check_out,currency,$3
         FROM booking.guest_bookings WHERE id=$1`,
        [syntheticBookingId, syntheticContextId, true],
      );

      const event = (
        bookingId: string,
        key: string,
        type: Parameters<typeof publish>[1]["eventType"],
        occurredAt: string,
      ) => ({
        source: type.startsWith("pms.") ? ("pms" as const) : ("booking" as const),
        eventKey: `${key}.${suffix}`,
        eventType: type,
        occurredAt,
        propertyId,
        bookingId,
        actorType: "system" as const,
        evidence: { sourceEvidenceId: key },
      });
      const amended = event(
        liveBookingId,
        "amended",
        "booking.affiliate_reservation.amended",
        "2026-09-02T10:00:00.000Z",
      );
      await publish(
        client,
        event(
          liveBookingId,
          "completed",
          "pms.affiliate_reservation.completed",
          "2026-09-04T10:00:00.000Z",
        ),
      );
      await publish(client, amended);
      await publish(
        client,
        event(
          liveBookingId,
          "canceled",
          "booking.affiliate_reservation.canceled",
          "2026-09-03T10:00:00.000Z",
        ),
      );
      await publish(client, amended);
      await publish(
        client,
        event(
          syntheticBookingId,
          "synthetic",
          "booking.affiliate_reservation.canceled",
          "2026-09-03T10:00:00.000Z",
        ),
      );
      await publish(
        client,
        event(
          unboundBookingId,
          "unbound",
          "booking.affiliate_reservation.canceled",
          "2026-09-03T10:00:00.000Z",
        ),
      );
      await client.query(
        `UPDATE booking.guest_bookings SET payment_status='unpaid',lifecycle_status='pending_payment',
           check_out='2026-10-04',created_at='2026-09-29T10:00:00Z',
           booking_metadata=jsonb_build_object('selectedOffer',jsonb_build_object('roomTypeId',$2::text))
         WHERE id=$1`,
        [liveBookingId, roomTypeId],
      );
      await client.query("SAVEPOINT rolled_back_evidence");
      await publish(
        client,
        event(
          liveBookingId,
          "rolled-back",
          "booking.affiliate_reservation.canceled",
          "2026-09-05T10:00:00.000Z",
        ),
      );
      await client.query("ROLLBACK TO SAVEPOINT rolled_back_evidence");

      const schedulerPool = (failPublication: boolean) =>
        ({
          query: client.query.bind(client),
          connect: async () =>
            new Proxy(client, {
              get(target, property) {
                if (property === "release") return () => undefined;
                if (property === "query")
                  return (sql: string, values?: unknown[]) => {
                    if (sql === "BEGIN") return target.query("SAVEPOINT booking_lifecycle");
                    if (sql === "COMMIT")
                      return target.query("RELEASE SAVEPOINT booking_lifecycle");
                    if (sql === "ROLLBACK")
                      return target.query("ROLLBACK TO SAVEPOINT booking_lifecycle");
                    if (failPublication && sql.includes("affiliate_original_booking_bindings"))
                      throw new Error("fixture publication failure");
                    return target.query(sql, values);
                  };
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        }) as unknown as pg.Pool;
      const runScheduler = (failPublication: boolean) =>
        runBookingLifecycleSchedulerJobs(
          createPgBookingLifecycleStore({
            connectionString: databaseUrl,
            pool: schedulerPool(failPublication),
          }),
          { now: new Date("2026-09-29T12:00:00Z"), run: ["staleUnpaidCancellation"] },
        );
      expect(await runScheduler(true)).toMatchObject({ applied: 0, failed: 1 });
      expect(
        (
          await client.query("SELECT lifecycle_status FROM booking.guest_bookings WHERE id=$1", [
            liveBookingId,
          ])
        ).rows[0].lifecycle_status,
      ).toBe("pending_payment");
      expect(await runScheduler(false)).toMatchObject({ applied: 1, failed: 0 });
      expect(await runScheduler(false)).toMatchObject({ scanned: 0, applied: 0, failed: 0 });

      const rows = (
        await client.query(
          `SELECT event_type,payload->'evidence'->>'sourceEvidenceId' AS source
           FROM platform.domain_events
           WHERE resource_type='affiliate_reservation' AND resource_id=$1
           ORDER BY occurred_at,id`,
          [liveBookingId],
        )
      ).rows;
      expect(rows).toEqual([
        { event_type: "booking.affiliate_reservation.amended", source: "amended" },
        { event_type: "booking.affiliate_reservation.canceled", source: "canceled" },
        { event_type: "pms.affiliate_reservation.completed", source: "completed" },
        { event_type: "booking.affiliate_reservation.canceled", source: null },
      ]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM platform.domain_events WHERE event_key LIKE $1",
            [`%.${suffix}`],
          )
        ).rows[0].count,
      ).toBe(3);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
