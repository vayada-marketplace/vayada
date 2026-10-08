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
const DATABASE = "vayada_hotel_setup_retire_test";
const RETIRE = "0474_hotel_setup_native_objects_retire.sql";

describe.skipIf(!URL)("hotel setup native objects 0474 retirement", () => {
  it("keeps native Owner-off receipts and leaves the hotel-setup roles droppable", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2056-"));
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
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 474)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();

      // A native Owner-off receipt, an unrelated native key value, and a plain row.
      const [org, off, other, plain] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await target.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Retire fixture',$2)",
        [org, `retire-${org}`],
      );
      await target.query(
        "ALTER TABLE identity.product_entitlements DISABLE TRIGGER hotel_setup_owner_off_receipt",
      );
      for (const [property, metadata] of [
        [off, { newHotelFinancialsDefault: "ready", newHotelFinancialsOwnerDisabled: true }],
        [other, { newHotelFinancialsDefault: "ready", newHotelFinancialsOwnerDisabled: false }],
        [plain, { newHotelFinancialsDefault: "ready" }],
      ] as const)
        await target.query(
          `INSERT INTO identity.product_entitlements
           (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id,metadata)
           VALUES ($1,'pms','module:financials','suspended','pms','pms_property',$2,$3::jsonb)`,
          [org, property, JSON.stringify(metadata)],
        );
      await target.query(
        "ALTER TABLE identity.product_entitlements ENABLE ALWAYS TRIGGER hotel_setup_owner_off_receipt",
      );

      await cp(join(MIGRATIONS, RETIRE), join(before, RETIRE));
      expect((await run()).applied).toEqual(["0474"]);

      // The receipt became the ordinary marker (valid while it equals xmin); the rest lost the key.
      const ownerOff = async () =>
        (
          await target!.query<{ id: string; ownerOff: boolean; native: boolean }>(
            `SELECT resource_id AS id,
               COALESCE(metadata->>'featureHubOwnerDisabled' = xmin::text, FALSE) AS "ownerOff",
               metadata ? 'newHotelFinancialsOwnerDisabled' AS native
             FROM identity.product_entitlements WHERE organization_id=$1 ORDER BY resource_id`,
            [org],
          )
        ).rows;
      expect(await ownerOff()).toEqual(
        [
          { id: off, ownerOff: true, native: false },
          { id: other, ownerOff: false, native: false },
          { id: plain, ownerOff: false, native: false },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      // Any later write cancels it, exactly as the native guard trigger did.
      await target.query(
        "UPDATE identity.product_entitlements SET updated_at=now() WHERE resource_id=$1",
        [off],
      );
      expect((await ownerOff()).find((row) => row.id === off)?.ownerOff).toBe(false);

      const count = async (sql: string) =>
        Number((await target!.query<{ n: string }>(sql)).rows[0]!.n);
      // Nothing native is left but the two triggers every writer relies on.
      expect(
        (
          await target.query(
            `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
             WHERE NOT t.tgisinternal AND (t.tgname ~ 'hotel_setup|entitlement_routing' OR p.proname ~ 'hotel_setup')
             ORDER BY 1`,
          )
        ).rows,
      ).toEqual([
        { name: "entitlement_routing_organization_lock" },
        { name: "hotel_setup_media_session_allocation_guard" },
      ]);
      expect(
        await count("SELECT count(*) AS n FROM pg_policy WHERE polname LIKE 'hotel\\_setup\\_%'"),
      ).toBe(0);
      expect(await count("SELECT count(*) AS n FROM pg_class WHERE relname ~ 'hotel_setup'")).toBe(
        0,
      );
      // RLS is off again where a hotel-setup migration had turned it on with no other policy.
      expect(
        await count(
          `SELECT count(*) AS n FROM pg_class WHERE relrowsecurity AND oid = ANY(ARRAY[
             'hotel_catalog.property_media'::regclass,'identity.organization_roles'::regclass,
             'platform.domain_events'::regclass,'platform.media_upload_sessions'::regclass,
             'pms.rate_rules'::regclass])`,
        ),
      ).toBe(0);
      // Nothing in this database depends on a hotel-setup role any more, so vayada_admin can drop them.
      expect(
        await count(
          `SELECT count(*) AS n FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
           WHERE r.rolname ~ '^vayada_next_hotel_setup_'
             AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())`,
        ),
      ).toBe(0);
    } finally {
      if (target) await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
