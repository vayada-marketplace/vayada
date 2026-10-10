import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0476_pms_property_navigation_modules.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const threadsOnly = "20780000-0000-4000-8000-000000000001";
const repliesAndChannelReview = "20780000-0000-4000-8000-000000000002";
const guestReviewOnly = "20780000-0000-4000-8000-000000000003";
const unused = "20780000-0000-4000-8000-000000000004";

describe("PMS navigation modules migration", () => {
  it("keeps the switches visibility-only and backfills from existing module data", () => {
    expect(migration).toContain("CREATE TABLE pms.property_navigation_modules");
    expect(migration).toContain("CHECK (module_id IN ('inbox', 'reviews'))");
    expect(migration).toContain("REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE");
    expect(migration).toContain("ON CONFLICT (property_id, module_id) DO NOTHING");
  });
});

// Runs on a database without the target schema (CI: before "Apply target migrations").
describe.skipIf(!TEST_DATABASE_URL)("PMS navigation modules migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA pms;
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      CREATE TABLE pms.message_threads (property_id UUID NOT NULL);
      CREATE TABLE pms.message_quick_replies (property_id UUID NOT NULL);
      CREATE TABLE pms.channel_reviews (property_id UUID NOT NULL);
      CREATE TABLE pms.guest_review_submissions (property_id UUID NOT NULL);
    `);
    await client.query("INSERT INTO hotel_catalog.properties (id) SELECT unnest($1::uuid[])", [
      [threadsOnly, repliesAndChannelReview, guestReviewOnly, unused],
    ]);
    for (const [table, propertyId] of [
      ["message_threads", threadsOnly],
      ["message_threads", threadsOnly],
      ["message_quick_replies", repliesAndChannelReview],
      ["channel_reviews", repliesAndChannelReview],
      ["guest_review_submissions", guestReviewOnly],
    ] as const) {
      await client.query(`INSERT INTO pms.${table} (property_id) VALUES ($1)`, [propertyId]);
    }
    await client.query(migration);
  });

  afterEach(async () => {
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA hotel_catalog CASCADE");
    await client.end();
  });

  it("turns modules on only for properties that already use them", async () => {
    const rows = await client.query(
      `SELECT property_id::text AS "propertyId", module_id AS "moduleId", is_active AS "isActive",
              activated_at IS NOT NULL AS "hasActivatedAt", deactivated_at
       FROM pms.property_navigation_modules ORDER BY property_id, module_id`,
    );
    expect(rows.rows).toEqual([
      {
        propertyId: threadsOnly,
        moduleId: "inbox",
        isActive: true,
        hasActivatedAt: true,
        deactivated_at: null,
      },
      {
        propertyId: repliesAndChannelReview,
        moduleId: "inbox",
        isActive: true,
        hasActivatedAt: true,
        deactivated_at: null,
      },
      {
        propertyId: repliesAndChannelReview,
        moduleId: "reviews",
        isActive: true,
        hasActivatedAt: true,
        deactivated_at: null,
      },
      {
        propertyId: guestReviewOnly,
        moduleId: "reviews",
        isActive: true,
        hasActivatedAt: true,
        deactivated_at: null,
      },
    ]);
  });

  it("rejects unknown modules and active rows without an activation time, and cascades", async () => {
    await expect(
      client.query(
        `INSERT INTO pms.property_navigation_modules (property_id, module_id, is_active)
         VALUES ($1, 'financials', FALSE)`,
        [unused],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `INSERT INTO pms.property_navigation_modules (property_id, module_id, is_active)
         VALUES ($1, 'inbox', TRUE)`,
        [unused],
      ),
    ).rejects.toMatchObject({ constraint: "chk_pms_navigation_module_activation" });

    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [threadsOnly]);
    const remaining = await client.query(
      "SELECT count(*)::int AS count FROM pms.property_navigation_modules WHERE property_id = $1",
      [threadsOnly],
    );
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });
});
