import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2456-";

// VAY-2456 (migration 0539): the agency booking page's tables and the one namespace agency and hotel
// addresses share. next-api writes them as `vayada_next_api_runtime`, so writes go through the test
// login that mirrors that role's product-DML posture; seeding runs as the admin.
describe.skipIf(!TEST_DATABASE_URL)("Agency booking page storage (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizations: string[] = [];
  let fixture: HotelSetupOrdinaryLoginFixture;
  let runtime: pg.Pool;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    runtime = new pg.Pool({ connectionString: fixture.connectionString, max: 3 });
  });

  afterAll(async () => {
    try {
      await runtime?.end();
      if (fixture) await fixture.drop();
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
          organizations,
        ]);
        await admin.query("DELETE FROM hotel_catalog.properties WHERE public_id LIKE $1", [
          `${PUBLIC_ID_PREFIX}%`,
        ]);
      }
    } finally {
      await admin.end();
    }
  });

  it("gives the runtime login ordinary writes and no way to call the guard itself", async () => {
    const result = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'booking.account_booking_pages', 'INSERT, UPDATE, DELETE') AS pages,
         has_table_privilege($1, 'booking.account_booking_page_properties', 'INSERT, UPDATE, DELETE')
           AS properties,
         has_function_privilege($1, 'booking.refuse_shared_booking_address()', 'EXECUTE') AS guard,
         (SELECT prosecdef FROM pg_proc
          WHERE oid = 'booking.refuse_shared_booking_address()'::regprocedure) AS definer`,
      [fixture.login],
    );
    expect(result.rows[0]).toEqual({ pages: true, properties: true, guard: false, definer: true });
  });

  it("stores one page per account with its included properties in order", async () => {
    const organizationId = await account();
    const [first, second] = [await property(), await property()];
    await runtime.query(
      `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
       VALUES ($1::uuid, $2, '{"page":{}}')`,
      [organizationId, `agency-${organizationId.slice(0, 8)}`],
    );
    await runtime.query(
      `INSERT INTO booking.account_booking_page_properties (organization_id, property_id, position)
       VALUES ($1::uuid, $2::uuid, 0), ($1::uuid, $3::uuid, 1)`,
      [organizationId, second, first],
    );
    const page = await admin.query(
      "SELECT live, revision FROM booking.account_booking_pages WHERE organization_id = $1::uuid",
      [organizationId],
    );
    expect(page.rows).toEqual([{ live: false, revision: 1 }]);

    // A second page for the account, a position used twice, or a property twice are refused.
    await expect(
      runtime.query(
        `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
         VALUES ($1::uuid, 'another-address', '{}')`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      runtime.query(
        `INSERT INTO booking.account_booking_page_properties (organization_id, property_id, position)
         VALUES ($1::uuid, $2::uuid, 1)`,
        [organizationId, await property()],
      ),
    ).rejects.toMatchObject({ constraint: "uq_account_booking_page_properties_position" });
    await expect(
      runtime.query(
        `INSERT INTO booking.account_booking_page_properties (organization_id, property_id, position)
         VALUES ($1::uuid, $2::uuid, 5)`,
        [organizationId, first],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    // Removing the page removes its list; removing the account removes the page.
    await runtime.query(
      "DELETE FROM booking.account_booking_pages WHERE organization_id = $1::uuid",
      [organizationId],
    );
    expect(await includedCount(organizationId)).toBe(0);
    await page_(organizationId, `agency-${organizationId.slice(0, 8)}`);
    await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
    expect(
      (
        await admin.query(
          "SELECT 1 FROM booking.account_booking_pages WHERE organization_id = $1::uuid",
          [organizationId],
        )
      ).rows,
    ).toEqual([]);
  });

  it("refuses addresses that aren't host labels and settings that aren't an object", async () => {
    const organizationId = await account();
    for (const slug of [
      "The-Agency",
      "-agency",
      "agency--x",
      "a.b",
      "www",
      "booking",
      "x".repeat(64),
    ])
      await expect(
        runtime.query(
          `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
           VALUES ($1::uuid, $2, '{}')`,
          [organizationId, slug],
        ),
        slug,
      ).rejects.toMatchObject({ constraint: "chk_account_booking_pages_slug" });
    await expect(
      runtime.query(
        `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
         VALUES ($1::uuid, 'fine-address', '[]')`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ constraint: "chk_account_booking_pages_settings" });
  });

  it("keeps agency and hotel addresses in one namespace, both ways", async () => {
    const hotel = await property();
    const n = randomUUID().slice(0, 8);
    // Every hotel slug counts: the canonical one and one it no longer uses.
    await admin.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, $2, 'canonical', 'active'), ($1::uuid, $3, 'redirect', 'retired')`,
      [hotel, `hotel-${n}`, `old-hotel-${n}`],
    );
    const agency = await account();
    for (const slug of [`hotel-${n}`, `old-hotel-${n}`])
      await expect(page_(agency, slug), slug).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_booking_address_slug",
      });

    await page_(agency, `agency-${n}`);
    await expect(
      runtime.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active')`,
        [await property(), `agency-${n}`],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "uq_booking_address_slug" });
    await expect(
      runtime.query("UPDATE hotel_catalog.property_slugs SET slug = $2 WHERE slug = $1", [
        `hotel-${n}`,
        `agency-${n}`,
      ]),
    ).rejects.toMatchObject({ constraint: "uq_booking_address_slug" });
    await expect(page_(await account(), `agency-${n}`)).rejects.toMatchObject({
      constraint: "uq_account_booking_pages_slug",
    });

    // Renaming the page checks the new address too; a free one is fine.
    await expect(
      runtime.query(
        "UPDATE booking.account_booking_pages SET slug = $2 WHERE organization_id = $1::uuid",
        [agency, `hotel-${n}`],
      ),
    ).rejects.toMatchObject({ constraint: "uq_booking_address_slug" });
    await runtime.query(
      "UPDATE booking.account_booking_pages SET slug = $2 WHERE organization_id = $1::uuid",
      [agency, `agency-new-${n}`],
    );
    // The page's former address is free again for hotels.
    await runtime.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, $2, 'canonical', 'active')`,
      [await property(), `agency-${n}`],
    );
  });

  it("makes a hotel writer wait for an agency page taking the same address, then refuses it", async () => {
    const agency = await account();
    const hotel = await property();
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const pageWriter = await runtime.connect();
    const hotelWriter = await runtime.connect();
    try {
      await pageWriter.query("BEGIN");
      await pageWriter.query(
        `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
         VALUES ($1::uuid, $2, '{}')`,
        [agency, slug],
      );
      await hotelWriter.query("SET lock_timeout = '10s'");
      let settled = false;
      const hotelInsert = hotelWriter
        .query(
          `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
           VALUES ($1::uuid, $2, 'canonical', 'active')`,
          [hotel, slug],
        )
        .finally(() => (settled = true));
      hotelInsert.catch(() => undefined);
      await waitUntil(async () => (await advisoryWaiters()) > 0);
      expect(settled).toBe(false);
      await pageWriter.query("COMMIT");
      await expect(hotelInsert).rejects.toMatchObject({ constraint: "uq_booking_address_slug" });
    } finally {
      await pageWriter.query("ROLLBACK").catch(() => undefined);
      pageWriter.release();
      hotelWriter.release();
    }
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    organizations.push(id);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2456 agency', $2, 'active')`,
      [id, `vay-2456-${id}`],
    );
    return id;
  }

  async function property(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-2456 stay')`,
      [id, `${PUBLIC_ID_PREFIX}${id}`],
    );
    return id;
  }

  async function page_(organizationId: string, slug: string) {
    await runtime.query(
      `INSERT INTO booking.account_booking_pages (organization_id, slug, settings)
       VALUES ($1::uuid, $2, '{}')`,
      [organizationId, slug],
    );
  }

  async function includedCount(organizationId: string) {
    const result = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM booking.account_booking_page_properties WHERE organization_id = $1::uuid",
      [organizationId],
    );
    return result.rows[0]!.n;
  }

  async function advisoryWaiters() {
    const result = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND database = (
         SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return result.rows[0]!.n;
  }
});

async function waitUntil(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition not reached within 5 seconds");
}

function assertSafeTestDatabase(url: string) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`Refusing to run against ${name}`);
}
