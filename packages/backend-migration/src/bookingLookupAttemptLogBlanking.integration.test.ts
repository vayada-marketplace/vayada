import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_booking_lookup_log_blanking_test";
const BLANKING = "0490_booking_lookup_attempt_log_blanking.sql";

// VAY-2222: "Find my booking" tries were logged with an unsalted SHA-256 of the caller's address.
// After 0490 they keep only that a try happened at a time.
describe.skipIf(!URL)("booking lookup attempt log blanking 0490", () => {
  it("blanks address hashes and request traces, leaves other rows, triggers unchanged", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2222-blank-"));
    const run = () =>
      runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 490)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const triggers = async () =>
        (
          await db.query(
            `SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
             FROM pg_trigger
             WHERE tgrelid = 'platform.product_audit_events'::regclass AND NOT tgisinternal
             ORDER BY 1`,
          )
        ).rows;
      const triggersBefore = await triggers();
      expect(triggersBefore.map((row) => row.tgenabled)).toEqual(["O"]);

      // A try in the shape the API wrote before VAY-2222, or another row for comparison.
      const audit = async (row: {
        action?: string;
        type?: string;
        id: string;
        age: string;
        correlation: string;
        causation: string;
      }) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO platform.product_audit_events (
               audit_key, product, action, occurred_at, tenant_scope,
               actor_type, target_resource_product, target_resource_type,
               target_resource_id, correlation_id, causation_id,
               redacted_payload, private_payload, audit_metadata,
               retention_class, privacy_scope
             ) VALUES (
               'booking.guest_lookup.attempt.' || md5(random()::text), 'booking', $1,
               now() - $2::interval, 'external', 'system', 'booking', $3, $4, $5, $6,
               '{"operation":"booking-lookup"}', '{}',
               '{"source":"apps/api-booking-web-public"}', 'security', 'restricted'
             ) RETURNING id`,
            [
              row.action ?? "booking.guest_lookup.attempt",
              row.age,
              row.type ?? "lookup_client_address_hash",
              row.id,
              row.correlation,
              row.causation,
            ],
          )
        ).rows[0]!.id;
      const hash = (address: string) =>
        createHash("sha256").update(`booking-lookup-client:${address}`).digest("hex");
      const tries = [
        await audit({
          id: hash("198.51.100.7"),
          age: "2 hours",
          correlation: "c-1",
          causation: "r-1",
        }),
        await audit({
          id: hash("198.51.100.7"),
          age: "3 hours",
          correlation: "r-2",
          causation: "r-2",
        }),
        await audit({
          id: hash("203.0.113.9"),
          age: "40 days",
          correlation: "c-3",
          causation: "r-3",
        }),
      ];
      const others = [
        await audit({
          action: "booking.guest_lookup.other",
          id: hash("192.0.2.1"),
          age: "2 hours",
          correlation: "c-4",
          causation: "r-4",
        }),
        await audit({
          type: "guest_booking",
          id: "booking-1",
          age: "2 hours",
          correlation: "c-5",
          causation: "r-5",
        }),
      ];
      const rows = async (ids: string[]) =>
        (
          await db.query(
            `SELECT * FROM platform.product_audit_events WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [ids],
          )
        ).rows;
      const triesBefore = await rows(tries);
      const othersBefore = await rows(others);

      // While the old API still logs tries with an address hash, the migration refuses to run.
      const recent = await audit({
        id: hash("198.51.100.8"),
        age: "1 minute",
        correlation: "c-6",
        causation: "r-6",
      });
      await cp(join(MIGRATIONS, BLANKING), join(before, BLANKING));
      expect((await run()).failed).toBe("0490");
      expect(await triggers()).toEqual(triggersBefore);
      await db.query("SET session_replication_role = replica");
      await db.query("DELETE FROM platform.product_audit_events WHERE id=$1", [recent]);
      await db.query("RESET session_replication_role");

      expect((await run()).applied).toEqual(["0490"]);

      // Each try keeps only that it happened, and when.
      expect(await rows(tries)).toEqual(
        triesBefore.map((row) => ({
          ...row,
          target_resource_type: "lookup_attempt",
          target_resource_id: row.id,
          correlation_id: null,
          causation_id: null,
        })),
      );
      expect(await rows(others)).toEqual(othersBefore);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM platform.product_audit_events
             WHERE target_resource_type = 'lookup_client_address_hash'
               AND action = 'booking.guest_lookup.attempt'`,
          )
        ).rows,
      ).toEqual([{ count: 0 }]);

      // The trigger is back exactly as it was, and the log is append-only again.
      expect(await triggers()).toEqual(triggersBefore);
      await expect(
        db.query("UPDATE platform.product_audit_events SET correlation_id = NULL WHERE id=$1", [
          others[1],
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        db.query("DELETE FROM platform.product_audit_events WHERE id=$1", [tries[0]]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
