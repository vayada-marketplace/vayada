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
const DATABASE = "vayada_hotel_account_invites_test";
const MIGRATION = 496;
const VIEW_DROPPED = 499;

// VAY-2272: hotel account invites leave the Marketplace schema; older images keep working through
// the marketplace.invite_codes view until 0499 drops it.
describe.skipIf(!URL)("hotel account invites out of the Marketplace schema 0496", () => {
  it("moves the hotel invites, drops the rest and keeps a writable compatibility view", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-invites-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const [owner, organization, property] = [randomUUID(), randomUUID(), randomUUID()];
      await db.query(
        `INSERT INTO identity.users (id, email) VALUES ($1::uuid, 'owner@example.test')`,
        [owner],
      );
      await db.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1::uuid, 'hotel_group', 'Invite hotel', $1::text)`,
        [organization],
      );
      await db.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $1::text, 'Invite hotel')`,
        [property],
      );
      const invite = async (type: string, status: string, extra: Record<string, unknown> = {}) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO marketplace.invite_codes
             (id, code, invite_type, status, payload, redeemed_by_user_id, property_id, redeemed_at)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::uuid, $7::uuid,
                   CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END)`,
          [
            id,
            `VAY-${id.slice(0, 8)}`,
            type,
            status,
            JSON.stringify({ track: type }),
            extra["redeemedBy"] ?? null,
            extra["property"] ?? null,
          ],
        );
        return id;
      };
      const pending = await invite("hotel", "pending", { property });
      const redeemed = await invite("hotel", "redeemed", { redeemedBy: owner });
      const creator = await invite("creator", "pending");
      const marketplace = await invite("marketplace", "expired");
      await db.query(
        `INSERT INTO hotel_catalog.prepared_import_applications (invite_id, organization_id, property_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [redeemed, organization, property],
      );
      const beforeRows = await db.query(
        `SELECT id::text, code, status, payload, created_by_user_id, redeemed_by_user_id, property_id,
                redeemed_at, expires_at, created_at
         FROM marketplace.invite_codes WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[pending, redeemed]],
      );

      // The compatibility view lives until 0499 drops it, so the rest of this test stops before 0499.
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < VIEW_DROPPED)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();

      // Only the hotel invites remain, unchanged, in their new home.
      expect(
        (
          await db.query(
            `SELECT id::text, code, status, payload, created_by_user_id, redeemed_by_user_id,
                    property_id, redeemed_at, expires_at, created_at
             FROM hotel_catalog.hotel_account_invites WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [[pending, redeemed, creator, marketplace]],
          )
        ).rows,
      ).toEqual(beforeRows.rows);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM hotel_catalog.hotel_account_invites
             WHERE invite_type <> 'hotel'`,
          )
        ).rows[0],
      ).toEqual({ count: 0 });

      // Names, columns and the prepared-import foreign key follow the table.
      const constraints = await db.query<{ name: string; type: string }>(
        `SELECT conname AS name, contype AS type FROM pg_catalog.pg_constraint
         WHERE conrelid = 'hotel_catalog.hotel_account_invites'::regclass
           AND contype IN ('p', 'u', 'f', 'c')
         ORDER BY conname`,
      );
      expect(constraints.rows).toEqual([
        { name: "chk_hotel_account_invites_dates", type: "c" },
        { name: "chk_hotel_account_invites_status", type: "c" },
        { name: "chk_hotel_account_invites_type", type: "c" },
        { name: "hotel_account_invites_code_key", type: "u" },
        { name: "hotel_account_invites_created_by_user_id_fkey", type: "f" },
        { name: "hotel_account_invites_pkey", type: "p" },
        { name: "hotel_account_invites_property_id_fkey", type: "f" },
        { name: "hotel_account_invites_redeemed_by_user_id_fkey", type: "f" },
      ]);
      expect(
        (
          await db.query(
            `SELECT indexname FROM pg_indexes
             WHERE schemaname = 'hotel_catalog' AND tablename = 'hotel_account_invites'
             ORDER BY indexname`,
          )
        ).rows.map((row) => row.indexname),
      ).toEqual([
        "hotel_account_invites_code_key",
        "hotel_account_invites_pkey",
        "idx_hotel_account_invites_status",
      ]);
      expect(
        (
          await db.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'hotel_catalog' AND table_name = 'hotel_account_invites'
               AND column_name LIKE 'creator%'`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.query(
            `SELECT confrelid::regclass::text AS referenced FROM pg_catalog.pg_constraint
             WHERE conrelid = 'hotel_catalog.prepared_import_applications'::regclass AND contype = 'f'
               AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                   WHERE attrelid = 'hotel_catalog.prepared_import_applications'::regclass
                                     AND attname = 'invite_id')]::int2[]`,
          )
        ).rows,
      ).toEqual([{ referenced: "hotel_catalog.hotel_account_invites" }]);
      expect(
        (
          await db.query(
            `SELECT table_type FROM information_schema.tables
             WHERE table_schema = 'marketplace' AND table_name = 'invite_codes'`,
          )
        ).rows,
      ).toEqual([{ table_type: "VIEW" }]);

      // An image from before 0496 issues, locks, redeems and lists invites through the view.
      const issued = await db.query<{ id: string; status: string; invite_type: string }>(
        `INSERT INTO marketplace.invite_codes (code, invite_type, payload)
         VALUES ('VAY-OLD-IMAGE', 'hotel', '{}'::jsonb) RETURNING *`,
      );
      expect(issued.rows[0]).toMatchObject({ status: "pending", invite_type: "hotel" });
      await db.query("BEGIN");
      await db.query(
        `SELECT id FROM marketplace.invite_codes WHERE code = 'VAY-OLD-IMAGE' FOR UPDATE`,
      );
      await db.query(
        `UPDATE marketplace.invite_codes SET status = 'redeemed', redeemed_at = now(),
                redeemed_by_user_id = $1::uuid
         WHERE code = 'VAY-OLD-IMAGE'`,
        [owner],
      );
      await db.query("COMMIT");
      expect(
        (
          await db.query(
            `SELECT status, redeemed_by_user_id::text AS "redeemedBy"
             FROM hotel_catalog.hotel_account_invites WHERE id = $1::uuid`,
            [issued.rows[0]!.id],
          )
        ).rows,
      ).toEqual([{ status: "redeemed", redeemedBy: owner }]);
      await expect(
        db.query(
          `INSERT INTO marketplace.invite_codes (code, invite_type) VALUES ('VAY-CREATOR', 'creator')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          `INSERT INTO hotel_catalog.hotel_account_invites (code, invite_type)
           VALUES ('VAY-AFFILIATE', 'affiliate')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
