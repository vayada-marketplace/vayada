import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_marketplace_grants_test";
const MIGRATION = 493;

type GrantRow = { organizationKind: string; roleKey: string; permissionKey: string };

// VAY-2270: no role holds a Marketplace or affiliate permission any more.
describe.skipIf(!URL)("retire Marketplace role grants 0493", () => {
  it("deletes Marketplace and affiliate grants and keeps every hotel grant", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2270-grants-"));
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
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;
      const grants = async () =>
        (
          await db.query<GrantRow>(
            `SELECT grant_row.organization_kind AS "organizationKind", grant_row.role_key AS "roleKey",
                    grant_row.permission_key AS "permissionKey"
             FROM identity.role_permission_grants grant_row
             ORDER BY 1, 2, 3`,
          )
        ).rows;
      const isMarketplace = (key: string) =>
        key.startsWith("marketplace.") || key.startsWith("affiliate.");

      const beforeGrants = await grants();
      expect(beforeGrants.some(({ permissionKey }) => isMarketplace(permissionKey))).toBe(true);
      expect(
        beforeGrants.some(
          ({ roleKey, permissionKey }) =>
            roleKey === "hotel_owner" && permissionKey === "marketplace.profile.manage",
        ),
      ).toBe(true);

      // Later migrations change what this checks (0501 deletes the catalog keys), so it stops at 0493.
      await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run(before)).failed).toBeNull();

      const afterGrants = await grants();
      expect(afterGrants.filter(({ permissionKey }) => isMarketplace(permissionKey))).toEqual([]);
      expect(
        afterGrants.filter(({ organizationKind }) =>
          ["creator_workspace", "affiliate_partner"].includes(organizationKind),
        ),
      ).toEqual([]);
      // Every other grant is untouched.
      expect(afterGrants).toEqual(
        beforeGrants.filter(
          ({ organizationKind, permissionKey }) =>
            !isMarketplace(permissionKey) &&
            !["creator_workspace", "affiliate_partner"].includes(organizationKind),
        ),
      );
      expect(
        afterGrants.some(
          ({ roleKey, permissionKey }) =>
            roleKey === "hotel_owner" && permissionKey === "hotel_catalog.setup.manage",
        ),
      ).toBe(true);
      // The catalog keys stay until 0501.
      const catalog = await db.query(
        `SELECT 1 FROM identity.permission_catalog WHERE key = 'marketplace.profile.manage'`,
      );
      expect(catalog.rowCount).toBe(1);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
