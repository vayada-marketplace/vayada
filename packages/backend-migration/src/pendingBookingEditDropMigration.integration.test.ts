import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_pending_booking_edit_drop_test";
const MIGRATION = 529;
const DROPPED_TABLES = [
  "booking.edit_authorization_releases",
  "booking.pending_booking_edit_attempts",
];
const DROPPED = [
  ...DROPPED_TABLES,
  "pms.pending_booking_edit_receipts",
  "pms.pending_booking_edit_support",
];

// VAY-2429: the guest Edit request flow is gone (VAY-2400); its views and tables go with every closed
// row, and only open work stops the drop.
describe.skipIf(!URL)("pending booking edit drop 0529", () => {
  it("drops the edit views and tables, refusing only while an attempt or a card hold is open", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2429-pending-edit-drop-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      let file = "";
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        if (Number(name.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, name), join(before, name));
        if (Number(name.slice(0, 4)) === MIGRATION) file = name;
      }
      expect(file).not.toBe("");
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const present = async () =>
        (
          await db.query<{ name: string }>(
            `SELECT n.nspname || '.' || c.relname AS name
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname || '.' || c.relname = ANY($1::text[]) ORDER BY 1`,
            [DROPPED],
          )
        ).rows.map((row) => row.name);
      expect(await present()).toEqual([...DROPPED].sort());

      // One LOCK covers the dropped tables and every table they reference, and nothing else.
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      const locked = sql
        .slice(sql.indexOf("LOCK TABLE") + "LOCK TABLE".length)
        .split("IN ACCESS EXCLUSIVE MODE")[0]!
        .split(",")
        .map((name) => name.trim());
      const referenced = await db.query<{ name: string }>(
        `SELECT DISTINCT target_namespace.nspname || '.' || target_table.relname AS name
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class source_table ON source_table.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
         JOIN pg_catalog.pg_class target_table ON target_table.oid = constraint_row.confrelid
         JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target_table.relnamespace
         WHERE constraint_row.contype = 'f'
           AND source_namespace.nspname || '.' || source_table.relname = ANY($1::text[])`,
        [DROPPED_TABLES],
      );
      expect(locked.sort()).toEqual(
        [...new Set([...DROPPED_TABLES, ...referenced.rows.map((row) => row.name)])].sort(),
      );

      // Closed rows as production has them (committed and released attempts, a released card hold).
      const [property, booking, quote] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Edit drop hotel')`,
        [property],
      );
      await db.query(
        `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
         VALUES ($1::uuid, $2::uuid, $1::text, 'pending_payment', '2027-01-01', '2027-01-03', 'EUR')`,
        [booking, property],
      );
      await db.query(
        `INSERT INTO booking.quote_sessions
           (id, property_id, request_hash, public_quote_reference, requested_check_in,
            requested_check_out, currency, expires_at)
         VALUES ($1::uuid, $2::uuid, $1::text, $1::text, '2027-01-01', '2027-01-03', 'EUR',
                 now() + interval '1 hour')`,
        [quote, property],
      );
      const attempt = (key: string, status: string) =>
        db.query<{ id: string }>(
          `INSERT INTO booking.pending_booking_edit_attempts
             (property_id, guest_booking_id, expected_revision, idempotency_key, request_fingerprint,
              quote_session_id, payment_method, status, committed_at, expires_at)
           VALUES ($1, $2, 0, $3, 'fingerprint', $4, 'pay_at_property', $5::text,
                   CASE WHEN $5::text = 'committed' THEN now() END, now() + interval '15 minutes')
           RETURNING id`,
          [property, booking, key, quote, status],
        );
      await attempt("edit-committed", "committed");
      const released = (await attempt("edit-released", "released")).rows[0]!.id;
      await db.query(
        `INSERT INTO booking.edit_authorization_releases
           (provider_payment_intent_id, provider_account_ref, property_id, released_at)
         VALUES ('pi_edit_hold', 'acct_edit', $1, now())`,
        [property],
      );

      const rows = async () => ({
        attempts: (
          await db.query<{ status: string }>(
            `SELECT status FROM booking.pending_booking_edit_attempts ORDER BY status`,
          )
        ).rows.map((row) => row.status),
        releases: (
          await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM booking.edit_authorization_releases
             WHERE released_at IS NOT NULL`,
          )
        ).rows[0]!.n,
      });
      const seeded = { attempts: ["committed", "released"], releases: 1 };
      expect(await rows()).toEqual(seeded);

      // Each gate stops the drop and changes nothing.
      await cp(join(MIGRATIONS, file), join(before, file));
      const gates: [string, string, string][] = [
        [
          `UPDATE booking.pending_booking_edit_attempts SET status = 'prepared' WHERE id = '${released}'`,
          `UPDATE booking.pending_booking_edit_attempts SET status = 'released' WHERE id = '${released}'`,
          "Pending booking edit attempts still open",
        ],
        [
          `UPDATE booking.pending_booking_edit_attempts SET status = 'release_pending' WHERE id = '${released}'`,
          `UPDATE booking.pending_booking_edit_attempts SET status = 'released' WHERE id = '${released}'`,
          "Pending booking edit attempts still open",
        ],
        [
          `UPDATE booking.edit_authorization_releases SET released_at = NULL`,
          `UPDATE booking.edit_authorization_releases SET released_at = now()`,
          "Edit card authorizations not yet released",
        ],
      ];
      for (const [trip, undo, message] of gates) {
        await db.query(trip);
        expect({ trip, failed: (await run(before)).failed }).toEqual({ trip, failed: "0529" });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0529' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await db.query(undo);
        expect({ trip, present: await present(), rows: await rows() }).toEqual({
          trip,
          present: [...DROPPED].sort(),
          rows: seeded,
        });
      }

      // Closed rows don't stop it: the drop takes them along.
      expect((await run(before)).failed).toBeNull();
      expect(await present()).toEqual([]);

      // The live parts of 0154 stay, and so does the booking.
      const kept = await db.query<{ name: string }>(
        `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
         WHERE table_schema = 'booking'
           AND (table_name, column_name) IN (('guest_bookings', 'edit_revision'),
                                             ('guest_bookings', 'active_card_payment_id'),
                                             ('booking_addon_selections', 'edit_revision'))
         UNION ALL
         SELECT 'view ' || table_name FROM information_schema.views
         WHERE table_schema = 'booking' AND table_name = 'active_booking_addon_selections'
         UNION ALL
         SELECT 'function ' || p.proname FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'booking' AND p.proname = 'protect_addon_edit_revision'
         UNION ALL
         SELECT 'trigger ' || t.tgname FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = 'booking.booking_addon_selections'::regclass
           AND t.tgname = 'trg_booking_addon_edit_revision_immutable'
         ORDER BY 1`,
      );
      expect(kept.rows.map((row) => row.name)).toEqual([
        "booking_addon_selections.edit_revision",
        "function protect_addon_edit_revision",
        "guest_bookings.active_card_payment_id",
        "guest_bookings.edit_revision",
        "trigger trg_booking_addon_edit_revision_immutable",
        "view active_booking_addon_selections",
      ]);
      expect(
        (await db.query(`SELECT id FROM booking.guest_bookings WHERE id = $1`, [booking])).rows,
      ).toEqual([{ id: booking }]);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
