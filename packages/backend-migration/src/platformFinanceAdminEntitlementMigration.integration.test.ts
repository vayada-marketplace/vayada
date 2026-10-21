import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { PLATFORM_ORGANIZATION_ID } from "./platformIdentityBootstrap.js";
import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_platform_finance_admin_entitlement_test";
const MIGRATION = 505;

type Entitlement = { status: string; source: string | null };

// VAY-2205: 0086 gave finance-admin only to the platform organizations of its day, and the platform
// identity bootstrap that later created Vayada Platform gave platform-admin only.
describe.skipIf(!URL)("platform finance-admin entitlement 0505", () => {
  it("gives finance-admin to the platform organization that operates Vayada, once, and nothing else", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const dir = await mkdtemp(join(tmpdir(), "vayada-2205-finance-admin-"));
    const run = () =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      let file = "";
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        const version = Number(name.slice(0, 4));
        if (version < MIGRATION) await cp(join(MIGRATIONS, name), join(dir, name));
        if (version === MIGRATION) file = name;
      }
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const organization = async (kind: string, status = "active", id: string = randomUUID()) => {
        await db.query(
          `INSERT INTO identity.organizations (id, kind, name, slug, status)
           VALUES ($1, $2, $3, $3, $4)`,
          [id, kind, `org-${id}`, status],
        );
        return id;
      };
      const link = (id: string, relationship = "operator", status = "active") =>
        db.query(
          `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'platform', 'platform', 'vayada', $2, $3)`,
          [id, relationship, status],
        );
      const entitle = (id: string, key: string, status = "active", source = "seed") =>
        db.query(
          `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id,
              metadata)
           VALUES ($1, 'platform', $2, $3, 'platform', 'platform', 'vayada', jsonb_build_object('source', $4::text))`,
          [id, key, status, source],
        );
      const financeAdmin = async (id: string) =>
        (
          await db.query<Entitlement>(
            `SELECT status, metadata->>'source' AS source FROM identity.product_entitlements
             WHERE organization_id = $1 AND product = 'platform' AND entitlement_key = 'finance-admin'
               AND resource_product = 'platform' AND resource_type = 'platform' AND resource_id = 'vayada'`,
            [id],
          )
        ).rows;

      // Vayada Platform as the bootstrap made it: operator link and platform-admin, no finance-admin.
      const vayada = await organization("platform", "active", PLATFORM_ORGANIZATION_ID);
      await link(vayada);
      await entitle(vayada, "platform-admin");
      // A platform organization with no members that 0086 already covered.
      const covered = await organization("platform");
      await link(covered);
      await entitle(
        covered,
        "finance-admin",
        "active",
        "0086_finance_affiliate_payout_payment_evidence",
      );
      // A Finance-only platform organization.
      const finance = await organization("platform");
      await link(finance, "finance_manager");
      // One whose entitlement was suspended on purpose.
      const suspended = await organization("platform");
      await link(suspended);
      await entitle(suspended, "finance-admin", "suspended");
      // Not operating Vayada: no link, a suspended link, a suspended organization, a hotel group.
      const unlinked = await organization("platform");
      const inactiveLink = await organization("platform");
      await link(inactiveLink, "operator", "suspended");
      const inactive = await organization("platform", "suspended");
      await link(inactive);
      const hotel = await organization("hotel_group");
      await link(hotel);
      const before = (
        await db.query("SELECT count(*)::int AS n FROM identity.product_entitlements")
      ).rows[0]!.n as number;

      await cp(join(MIGRATIONS, file), join(dir, file));
      const result = await run();
      expect(result.failed).toBeNull();
      expect(result.applied.some((name) => name.includes("0505"))).toBe(true);

      const source = "0505_platform_finance_admin_entitlement";
      expect(await financeAdmin(vayada)).toEqual([{ status: "active", source }]);
      expect(await financeAdmin(finance)).toEqual([{ status: "active", source }]);
      expect(await financeAdmin(covered)).toEqual([
        { status: "active", source: "0086_finance_affiliate_payout_payment_evidence" },
      ]);
      expect(await financeAdmin(suspended)).toEqual([{ status: "suspended", source: "seed" }]);
      for (const id of [unlinked, inactiveLink, inactive, hotel])
        expect(await financeAdmin(id)).toEqual([]);
      const count = async () =>
        (await db.query("SELECT count(*)::int AS n FROM identity.product_entitlements")).rows[0]!
          .n as number;
      expect(await count()).toBe(before + 2);

      // Run again: nothing new.
      await db.query("BEGIN");
      await db.query(await readFile(join(MIGRATIONS, file), "utf8"));
      await db.query("COMMIT");
      expect(await count()).toBe(before + 2);
      expect(await financeAdmin(vayada)).toEqual([{ status: "active", source }]);
    } finally {
      await target?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
