import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_addon_lead_time_test";
const CONVERSION = "0491_booking_addon_lead_time_choices.sql";

// VAY-2232: free-text add-on lead times become the editor's fixed choices (leadTimeHours).
describe.skipIf(!URL)("add-on lead time conversion 0491", () => {
  it("rounds each readable lead time up to a choice and keeps the old text aside", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2232-lead-time-"));
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
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 491)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const hotel = randomUUID();
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Lead time hotel')",
        [hotel],
      );
      const addon = async (metadata: Record<string, unknown>) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,currency,metadata,updated_at)
           VALUES($1,$2,'Extra','per_stay','EUR',$3,'2026-10-01T00:00:00Z')`,
          [id, hotel, JSON.stringify(metadata)],
        );
        return id;
      };
      const converted: [string, number | null][] = [
        ["10h", 12],
        ["12 Stunden", 12],
        ["30 min", 12],
        ["24h before", 24],
        ["a day", 24],
        ["One day", 24],
        ["24", 24],
        ["2 days", 48],
        ["48 hours", 48],
        ["1,5 Tage", 48],
        ["3d", 72],
        ["1 week", 168],
        ["2 weeks", 168],
        ["asap", null],
        // Words and other languages.
        ["Book and pay 48 hours before", 48],
        ["Breakfast and dinner", null],
        ["the day before", null],
        ["24-hour", 24],
        ["an hour", 12],
        ["2 Tagen", 48],
        ["30 Minuten", 12],
        ["24 horas", 24],
        ["3 jours", 72],
        ["2 hari", 48],
        ["24 uur", 24],
        ["1 semana", 168],
        ["1 minggu", 168],
      ];
      const ids = new Map<string, string>();
      for (const [text] of converted)
        ids.set(text, await addon({ maxQuantity: 3, leadTime: text }));
      const empty = await addon({ maxQuantity: 2, leadTime: "  " }),
        nullText = await addon({ leadTime: null }),
        chosen = await addon({ leadTimeHours: 72, leadTime: "1 day" }),
        chosenNull = await addon({ leadTimeHours: 24, leadTime: null }),
        untouched = await addon({ maxQuantity: 2 });

      await cp(join(MIGRATIONS, CONVERSION), join(before, CONVERSION));
      expect((await run()).failed).toBeNull();

      const read = async (id: string) =>
        (
          await db.query("SELECT metadata, updated_at FROM booking.addon_definitions WHERE id=$1", [
            id,
          ])
        ).rows[0] as { metadata: Record<string, unknown>; updated_at: Date };
      for (const [text, hours] of converted)
        expect((await read(ids.get(text)!)).metadata, text).toEqual({
          maxQuantity: 3,
          leadTimeHours: hours,
          legacyLeadTime: text,
        });
      expect((await read(empty)).metadata).toEqual({ maxQuantity: 2 });
      expect((await read(nullText)).metadata).toEqual({});
      expect((await read(chosen)).metadata).toEqual({
        leadTimeHours: 72,
        legacyLeadTime: "1 day",
      });
      expect((await read(chosenNull)).metadata).toEqual({ leadTimeHours: 24 });
      expect((await read(untouched)).metadata).toEqual({ maxQuantity: 2 });
      // A data conversion, not a host's edit.
      expect((await read(ids.get("10h")!)).updated_at.toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM booking.addon_definitions WHERE metadata ? 'leadTime'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});

// VAY-2391: when each add-on happens. Existing add-ons keep what they do today.
describe.skipIf(!URL)("add-on schedule backfill 0525", () => {
  it("makes per-night prices every day and one-off transport the arrival day", async () => {
    assertSafeTestDatabase(URL!);
    const database = "vayada_addon_schedule_test";
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${database}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2391-schedule-"));
    const run = () =>
      runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${database}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 525)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;
      const hotel = randomUUID();
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Schedule hotel')",
        [hotel],
      );
      const addon = async (pricingModel: string, category: string | null, status = "active") => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,category,currency,status)
           VALUES($1,$2,'Extra',$3,$4,'EUR',$5)`,
          [id, hotel, pricingModel, category, status],
        );
        return id;
      };
      const expected: [string, string][] = [
        [await addon("per_night", "dining"), "daily"],
        [await addon("per_guest_night", "transport"), "daily"],
        [await addon("per_stay", "transport"), "arrival"],
        [await addon("per_guest", " Transport "), "arrival"],
        [await addon("per_stay", "transport", "retired"), "arrival"],
        [await addon("per_stay", "dining"), "guest_pick"],
        [await addon("per_guest", null), "guest_pick"],
      ];

      await cp(
        join(MIGRATIONS, "0525_booking_addon_schedule.sql"),
        join(before, "0525_booking_addon_schedule.sql"),
      );
      expect((await run()).failed).toBeNull();

      for (const [id, mode] of expected)
        expect(
          (
            await db.query(
              "SELECT schedule_mode, bookable_weekdays FROM booking.addon_definitions WHERE id=$1",
              [id],
            )
          ).rows[0],
        ).toEqual({ schedule_mode: mode, bookable_weekdays: [1, 2, 3, 4, 5, 6, 7] });
      // New rows get the defaults; the checks refuse unknown modes and weekdays.
      expect(
        (
          await db.query("SELECT schedule_mode FROM booking.addon_definitions WHERE id=$1", [
            await addon("per_stay", "dining"),
          ])
        ).rows[0].schedule_mode,
      ).toBe("guest_pick");
      for (const [column, value, constraint] of [
        ["schedule_mode", "weekly", "chk_addon_definitions_schedule_mode"],
        ["bookable_weekdays", "{}", "chk_addon_definitions_bookable_weekdays"],
        ["bookable_weekdays", "{0,1}", "chk_addon_definitions_bookable_weekdays"],
        ["bookable_weekdays", "{1,NULL}", "chk_addon_definitions_bookable_weekdays"],
        ["bookable_weekdays", "{{1,2},{3,4}}", "chk_addon_definitions_bookable_weekdays"],
      ])
        await expect(
          db.query(`UPDATE booking.addon_definitions SET ${column}=$1 WHERE id=$2`, [
            value,
            expected[0][0],
          ]),
        ).rejects.toMatchObject({ constraint });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
