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
const DATABASE = "vayada_payment_currency_cascade_test";
const CASCADE = "0526_finance_payment_currency_follows_pricing.sql";

// VAY-2390 P5: before 0526 a bound Finance row pinned the pricing currency; after it, the row follows.
describe.skipIf(!URL)("Finance payment currency cascade 0526", () => {
  it("lets a pricing currency change carry its bound Finance row, and only that row", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2390-cascade-"));
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
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 526)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const [hotel, other] = [randomUUID(), randomUUID()];
      for (const property of [hotel, other]) {
        await db.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Cascade hotel')",
          [property],
        );
        await db.query(
          "INSERT INTO pms.property_pricing_settings(property_id,currency,pricing_currency_revision) VALUES($1,'EUR',1)",
          [property],
        );
        await db.query(
          `INSERT INTO finance.payment_settings(property_id,default_currency,payment_readiness_contract_version,
             payment_methods_revision,source_pricing_currency_revision)
           VALUES($1,'EUR','finance-payment-readiness.v1',1,1)`,
          [property],
        );
      }
      const change = () =>
        db.query(
          `UPDATE pms.property_pricing_settings SET currency='CHF', pricing_currency_revision=2
           WHERE property_id=$1`,
          [hotel],
        );
      const finance = async () =>
        (
          await db.query(
            `SELECT property_id::text, default_currency::text, source_pricing_currency_revision::int
             FROM finance.payment_settings ORDER BY property_id`,
          )
        ).rows;

      await expect(change()).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_finance_payment_settings_pricing_currency_revision",
      });

      await cp(join(MIGRATIONS, CASCADE), join(before, CASCADE));
      expect((await run()).failed).toBeNull();
      await change();
      expect(await finance()).toEqual(
        [
          { property_id: hotel, default_currency: "CHF", source_pricing_currency_revision: 2 },
          { property_id: other, default_currency: "EUR", source_pricing_currency_revision: 1 },
        ].sort((a, b) => a.property_id.localeCompare(b.property_id)),
      );
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
