import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const connectionString = process.env["TEST_DATABASE_URL"];

describe.skipIf(!connectionString)("add-on revenue evidence", () => {
  it("keeps active fulfillment and append-only adjustments scoped and private", async () => {
    assertSafeTestDatabase(connectionString!);
    const migrations = await runMigrations({
      connectionString: connectionString!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(migrations.failed).toBeNull();
    const client = new pg.Client({ connectionString });
    await client.connect();
    const property = randomUUID();
    const otherProperty = randomUUID();
    const booking = randomUUID();
    const otherBooking = randomUUID();
    try {
      const selections = Array.from({ length: 6 }, () => randomUUID());
      const evidence = Array.from({ length: 8 }, () => randomUUID());
      await client.query(
        `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
         VALUES ($1::uuid,$1::text,'Add-on evidence'),
                ($2::uuid,$2::text,'Other property')`,
        [property, otherProperty],
      );
      await client.query(
        `INSERT INTO booking.guest_bookings
          (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
         VALUES ($1::uuid,$2::uuid,$1::text,'completed','2026-01-01','2026-01-03','EUR'),
                ($3::uuid,$4::uuid,$3::text,'completed','2026-01-01','2026-01-03','EUR')`,
        [booking, property, otherBooking, otherProperty],
      );
      await client.query(
        `INSERT INTO booking.booking_addon_selections
          (id,property_id,guest_booking_id,service_date,total_amount,currency,
           ownership_kind_snapshot,partner_commission_rate_snapshot,edit_revision)
         VALUES ($1,$7,$8,'2026-01-01',100,'EUR','property',NULL,0),
                ($2,$7,$8,'2026-01-01',30,'EUR','property',NULL,0),
                ($3,$7,$8,NULL,200,'EUR','partner',12.5,1),
                ($4,$7,$8,'2026-01-02',15,'EUR','property',NULL,1),
                ($5,$7,$8,'2026-01-02',50,'EUR','property',NULL,1),
                ($6,$9,$10,'2026-01-01',40,'EUR','property',NULL,0)`,
        [...selections, property, booking, otherProperty, otherBooking],
      );
      const insert = async (
        selection: string,
        gross: number | null,
        command: string,
        options: {
          id?: string;
          propertyId?: string;
          bookingId?: string;
          date?: string;
          quantity?: number;
          ownership?: string;
          rate?: number | null;
          event?: string;
          quality?: string;
          revision?: number;
          corrects?: string | null;
        } = {},
        executor: pg.Client = client,
      ) => {
        const {
          id = randomUUID(),
          propertyId = property,
          bookingId = booking,
          date = "2026-01-01",
          quantity = 1,
          ownership = "property",
          rate = null,
          event = "fulfillment",
          quality = "exact",
          revision = 1,
          corrects = null,
        } = options;
        return executor.query(
          `INSERT INTO booking.addon_revenue_evidence
            (id,addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,
             currency,gross_amount,ownership_kind,partner_commission_rate,economic_event,
             evidence_quality,source_revision,corrects_evidence_id,command_key)
           VALUES ($1,$2,$3,$4,$5,$6,'EUR',$7,$8,$9,$10,$11,$12,$13,$14)`,
          // prettier-ignore
          [id, selection, propertyId, bookingId, date, quantity, gross, ownership, rate, event, quality, revision, corrects, command],
        );
      };
      const rejects = (action: () => Promise<unknown>, code: string) =>
        expect(action()).rejects.toMatchObject({ code });

      await insert(selections[0]!, 100, "old-fulfillment", { id: evidence[0] });
      await rejects(() => insert(selections[1]!, 29, "wrong-gross"), "23514");
      await client.query("UPDATE booking.guest_bookings SET edit_revision=1 WHERE id=$1", [
        booking,
      ]);
      await rejects(() => insert(selections[1]!, 30, "inactive"), "23503");
      await rejects(
        // prettier-ignore
        () => insert(selections[2]!, 200, "wrong-snapshot", { ownership: "partner", rate: 12.4, quality: "inferred" }),
        "23514",
      );
      // prettier-ignore
      await rejects(() => insert(selections[2]!, 200, "wrong-owner", { ownership: "property", quality: "inferred" }), "23514");
      // prettier-ignore
      await rejects(() => insert(selections[2]!, 200, "wrong-quantity", { quantity: 2, ownership: "partner", rate: 12.5, quality: "inferred" }), "23514");
      // prettier-ignore
      await insert(selections[2]!, 200, "new-fulfillment", { id: evidence[1], ownership: "partner", rate: 12.5, quality: "inferred" });
      // prettier-ignore
      await insert(selections[3]!, null, "missing", { id: evidence[2], date: "2026-01-02", event: "missing_fulfillment", quality: "missing" });
      // prettier-ignore
      await insert(selections[0]!, -20, "old-refund", { id: evidence[3], date: "2026-01-02", event: "refund", revision: 2, corrects: evidence[0] });
      await rejects(
        // prettier-ignore
        () => insert(selections[0]!, -81, "over-refund", { date: "2026-01-03", event: "refund", revision: 3, corrects: evidence[3] }),
        "23514",
      );
      // prettier-ignore
      await insert(selections[0]!, 5, "old-correction", { id: evidence[4], date: "2026-01-03", event: "correction", revision: 3, corrects: evidence[3] });
      await rejects(
        // prettier-ignore
        () => insert(selections[0]!, -5, "branch", { date: "2026-01-02", event: "refund", revision: 2, corrects: evidence[0] }),
        "23505",
      );
      // prettier-ignore
      await insert(selections[5]!, 40, "other-base", { id: evidence[5], propertyId: otherProperty, bookingId: otherBooking });
      await expect(
        // prettier-ignore
        insert(selections[5]!, -5, "cross-property", { propertyId: otherProperty, bookingId: otherBooking, date: "2026-01-03", event: "refund", revision: 2, corrects: evidence[4] }),
      ).rejects.toMatchObject({ code: "23514", constraint: "chk_booking_addon_revenue_chain" });

      const peer = new pg.Client({ connectionString });
      await peer.connect();
      try {
        await client.query("BEGIN");
        await insert(selections[4]!, 50, "racing-base", { id: evidence[6], date: "2026-01-02" });
        await peer.query("SET lock_timeout='100ms'");
        await expect(
          peer.query("UPDATE booking.guest_bookings SET edit_revision=2 WHERE id=$1", [booking]),
        ).rejects.toMatchObject({ code: "55P03" });
        await client.query("ROLLBACK");

        const peerPid = (await peer.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!
          .pid;
        await peer.query("SET lock_timeout=0; BEGIN");
        await client.query("BEGIN");
        // prettier-ignore
        await insert(selections[2]!, -10, "winning-adjustment", { id: evidence[7], date: "2026-01-02", event: "correction", revision: 2, corrects: evidence[1], ownership: "partner", rate: 12.5 });
        // prettier-ignore
        const collision = insert(selections[2]!, -5, "losing-adjustment", { date: "2026-01-02", event: "correction", revision: 2, corrects: evidence[1], ownership: "partner", rate: 12.5 }, peer);
        await expect
          .poll(async () =>
            Number(
              (await client.query("SELECT cardinality(pg_blocking_pids($1)) blockers", [peerPid]))
                .rows[0]?.blockers,
            ),
          )
          .toBeGreaterThan(0);
        await client.query("COMMIT");
        await expect(collision).rejects.toMatchObject({ code: "23505" });
        await peer.query("ROLLBACK");
        const successors = await client.query(
          "SELECT count(*)::int count FROM booking.addon_revenue_evidence WHERE corrects_evidence_id=$1",
          [evidence[1]],
        );
        expect(successors.rows[0]?.count).toBe(1);
      } finally {
        await peer.query("ROLLBACK");
        await peer.end();
      }

      const projection = await client.query(
        `SELECT economic_event,gross_amount,evidence_quality,source_revision
         FROM booking.finance_addon_revenue_evidence
         WHERE property_id=$1 ORDER BY created_at,evidence_id`,
        [property],
      );
      expect(projection.rows).toHaveLength(6);
      const rows = projection.rows.map((row) => [
        row.economic_event,
        row.gross_amount,
        row.evidence_quality,
        row.source_revision,
      ]);
      expect(rows).toEqual(
        expect.arrayContaining([
          ["fulfillment", "100.0000", "exact", 1],
          ["fulfillment", "200.0000", "inferred", 1],
          ["missing_fulfillment", null, "missing", 1],
          ["refund", "-20.0000", "exact", 2],
          ["correction", "5.0000", "exact", 3],
          ["correction", "-10.0000", "exact", 2],
        ]),
      );
      expect(projection.fields.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(["addon_snapshot", "first_name", "email", "phone"]),
      );
      await rejects(
        () =>
          client.query("UPDATE booking.addon_revenue_evidence SET gross_amount=0 WHERE id=$1", [
            evidence[0],
          ]),
        "55000",
      );
      await rejects(
        () =>
          client.query(
            `INSERT INTO booking.finance_addon_revenue_evidence
          (evidence_id,addon_selection_id,property_id,guest_booking_id,recognized_on,quantity,
           currency,ownership_kind,economic_event,evidence_quality,source_revision,created_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'2026-01-01',1,'EUR','property',
           'missing_fulfillment','missing',1,now())`,
            [selections[2], property, booking],
          ),
        "55000",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      // prettier-ignore
      for (const table of ["booking.addon_revenue_evidence", "booking.booking_addon_selections", "booking.guest_bookings"]) {
        await client.query(`DELETE FROM ${table} WHERE property_id=ANY($1)`, [[property, otherProperty]]);
      }
      // prettier-ignore
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1)", [[property, otherProperty]]);
      await client.query("COMMIT");
      await client.end();
    }
  }, 60_000);
});
