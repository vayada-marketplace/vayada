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
const DATABASE = "vayada_active_room_numbers_test";
const MIGRATION = "0541_pms_rooms_active_room_numbers.sql";
const RULES = ["uq_pms_rooms_property_number", "uq_pms_rooms_property_verified_label_ci"];
const migration = await readFile(join(MIGRATIONS, MIGRATION), "utf8");

// VAY-2467: a deleted (retired) room no longer keeps its room number taken.
describe("active room numbers migration 0541", () => {
  it("rebuilds only the two room-number rules, under their old names, for rooms in use", () => {
    const statements = migration
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE pms.rooms DROP CONSTRAINT uq_pms_rooms_property_number",
      "CREATE UNIQUE INDEX uq_pms_rooms_property_number ON pms.rooms (property_id, room_number) WHERE status <> 'retired'",
      "DROP INDEX pms.uq_pms_rooms_property_verified_label_ci",
      "CREATE UNIQUE INDEX uq_pms_rooms_property_verified_label_ci ON pms.rooms (property_id, lower(room_number)) WHERE operational_label_status = 'verified' AND status <> 'retired'",
    ]);
  });
});

describe.skipIf(!URL)("active room numbers migration 0541 (PostgreSQL)", () => {
  it("frees the numbers of deleted rooms and still keeps rooms in use apart", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2467-room-numbers-"));
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
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 541)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const hotel = randomUUID();
      const studio = randomUUID();
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Room numbers hotel')",
        [hotel],
      );
      await db.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Studio')", [
        studio,
        hotel,
      ]);
      const addRoom = async (number: string, labelStatus: string, status = "available") =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO pms.rooms(property_id,room_type_id,room_number,operational_label_status,status)
             VALUES($1,$2,$3,$4,$5) RETURNING id::text`,
            [hotel, studio, number, labelStatus, status],
          )
        ).rows[0]!.id;
      const rename = (id: string, number: string) =>
        db.query(
          "UPDATE pms.rooms SET room_number=$2, operational_label_status='verified' WHERE id=$1",
          [id, number],
        );
      const clash = async (write: Promise<unknown>) => {
        const error = await write.then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({ code: "23505" });
        return (error as pg.DatabaseError).constraint;
      };

      // Deleted in PMS (label stays verified) and removed by lowering total rooms (unverified).
      await addRoom("Studio 2", "verified", "retired");
      await addRoom("Studio 3", "unverified", "retired");
      const studio4 = await addRoom("Studio 4", "verified");
      const studio5 = await addRoom("Studio 5", "verified");

      expect(RULES).toContain(await clash(rename(studio4, "Studio 2")));
      expect(await clash(rename(studio5, "Studio 3"))).toBe("uq_pms_rooms_property_number");
      expect(await clash(rename(studio5, "studio 2"))).toBe(
        "uq_pms_rooms_property_verified_label_ci",
      );

      await cp(join(MIGRATIONS, MIGRATION), join(before, MIGRATION));
      expect((await run()).failed).toBeNull();

      await rename(studio4, "Studio 2");
      await rename(studio5, "Studio 3");
      // The same number can be freed again.
      await db.query("UPDATE pms.rooms SET status='retired' WHERE id=$1", [studio4]);
      await addRoom("Studio 2", "verified");
      await addRoom("Studio 6", "unverified");

      // Two rooms in use still can't share a number: exactly, or in any case once verified.
      expect(await clash(addRoom("STUDIO 2", "verified"))).toBe(
        "uq_pms_rooms_property_verified_label_ci",
      );
      expect(await clash(addRoom("Studio 6", "unverified"))).toBe("uq_pms_rooms_property_number");
      expect(await clash(addRoom("Studio 6", "verified"))).toBe("uq_pms_rooms_property_number");

      // Deleted rooms keep their numbers for history.
      const { rows } = await db.query<{ number: string; status: string; label: string }>(
        `SELECT room_number AS number, status, operational_label_status AS label
         FROM pms.rooms WHERE property_id=$1 ORDER BY room_number COLLATE "C", status`,
        [hotel],
      );
      expect(rows).toEqual([
        { number: "Studio 2", status: "available", label: "verified" },
        { number: "Studio 2", status: "retired", label: "verified" },
        { number: "Studio 2", status: "retired", label: "verified" },
        { number: "Studio 3", status: "available", label: "verified" },
        { number: "Studio 3", status: "retired", label: "unverified" },
        { number: "Studio 6", status: "available", label: "unverified" },
      ]);

      const { rows: indexes } = await db.query<{ name: string; definition: string }>(
        `SELECT indexname AS name, indexdef AS definition FROM pg_indexes
         WHERE schemaname='pms' AND tablename='rooms' AND indexname = ANY($1::text[])
         ORDER BY indexname`,
        [RULES],
      );
      expect(indexes).toEqual([
        {
          name: "uq_pms_rooms_property_number",
          definition:
            "CREATE UNIQUE INDEX uq_pms_rooms_property_number ON pms.rooms USING btree (property_id, room_number) WHERE (status <> 'retired'::text)",
        },
        {
          name: "uq_pms_rooms_property_verified_label_ci",
          definition:
            "CREATE UNIQUE INDEX uq_pms_rooms_property_verified_label_ci ON pms.rooms USING btree (property_id, lower(room_number)) WHERE ((operational_label_status = 'verified'::text) AND (status <> 'retired'::text))",
        },
      ]);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
