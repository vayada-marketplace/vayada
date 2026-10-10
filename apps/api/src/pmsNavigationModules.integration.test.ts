import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgPmsNavigationModuleRepository,
  type PmsNavigationModuleRepository,
} from "./routes/pmsNavigationModules.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2078-";

// VAY-2078: next-api reads and writes the switches as `vayada_next_api_runtime`, so this suite
// runs the repository through the test login that mirrors that role's product-DML posture. A new
// pms table is covered by the migration owner's default privileges in production.
describe.skipIf(!TEST_DATABASE_URL)("PMS navigation modules (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: PmsNavigationModuleRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-2078', 'active')`,
      [actorUserId, `vay-2078-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgPmsNavigationModuleRepository({
      connectionString: fixture.connectionString,
    });
  });

  afterAll(async () => {
    try {
      await repository?.close?.();
      if (fixture) {
        await waitForSessionsToEnd(admin, fixture.login);
        await fixture.drop();
      }
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanupFixtures(admin);
        await admin.query("DELETE FROM identity.users WHERE id=$1::uuid", [actorUserId]);
      }
    } finally {
      await admin.end();
    }
  });

  it("has ordinary DML on the switches table and nothing more on the audit sink", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'pms.property_navigation_modules', 'SELECT') AS "select",
         has_table_privilege($1, 'pms.property_navigation_modules', 'INSERT') AS "insert",
         has_table_privilege($1, 'pms.property_navigation_modules', 'UPDATE') AS "update",
         has_table_privilege($1, 'platform.product_audit_events', 'INSERT') AS "auditInsert",
         has_table_privilege($1, 'platform.product_audit_events', 'UPDATE') AS "auditUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({
      select: true,
      insert: true,
      update: true,
      auditInsert: true,
      auditUpdate: false,
    });
  });

  it("starts off, then switches modules on and off with an audit row per change", async () => {
    const propertyId = await seedProperty(admin);
    const audit = { actorUserId, organizationId, requestId: randomUUID(), correlationId: null };
    expect(await repository.list(propertyId)).toEqual([]);

    const on = await repository.update({ propertyId, moduleId: "inbox", isActive: true, audit });
    expect(on).toMatchObject({ moduleId: "inbox", isActive: true, deactivatedAt: null });
    expect(on.activatedAt).toEqual(expect.any(String));

    const off = await repository.update({ propertyId, moduleId: "inbox", isActive: false, audit });
    expect(off).toMatchObject({ isActive: false, activatedAt: on.activatedAt });
    expect(off.deactivatedAt).toEqual(expect.any(String));

    const again = await repository.update({ propertyId, moduleId: "inbox", isActive: true, audit });
    expect(again).toMatchObject({ isActive: true, deactivatedAt: null });
    await repository.update({ propertyId, moduleId: "inbox", isActive: false, audit });

    await repository.update({ propertyId, moduleId: "reviews", isActive: true, audit });
    expect(
      (await repository.list(propertyId)).map(({ moduleId, isActive }) => ({ moduleId, isActive })),
    ).toEqual([
      { moduleId: "inbox", isActive: false },
      { moduleId: "reviews", isActive: true },
    ]);

    const audits = await admin.query(
      `SELECT action, actor_user_id::text AS "actorUserId", redacted_payload AS payload,
              audit_metadata->>'organizationId' AS "organizationId"
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [propertyId],
    );
    expect(audits.rows).toEqual([
      {
        action: "pms.navigation_module.activated",
        actorUserId,
        payload: { moduleId: "inbox", isActive: true },
        organizationId,
      },
      {
        action: "pms.navigation_module.deactivated",
        actorUserId,
        payload: { moduleId: "inbox", isActive: false },
        organizationId,
      },
      {
        action: "pms.navigation_module.activated",
        actorUserId,
        payload: { moduleId: "inbox", isActive: true },
        organizationId,
      },
      {
        action: "pms.navigation_module.deactivated",
        actorUserId,
        payload: { moduleId: "inbox", isActive: false },
        organizationId,
      },
      {
        action: "pms.navigation_module.activated",
        actorUserId,
        payload: { moduleId: "reviews", isActive: true },
        organizationId,
      },
    ]);
  });
});

async function seedProperty(admin: pg.Pool): Promise<string> {
  const propertyId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'Navigation Modules')`,
    [propertyId, `${PUBLIC_ID_PREFIX}${propertyId}`],
  );
  return propertyId;
}

async function cleanupFixtures(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = await client.query<{ id: string }>(
      "SELECT id FROM hotel_catalog.properties WHERE public_id LIKE $1",
      [`${PUBLIC_ID_PREFIX}%`],
    );
    const ids = fixtures.rows.map(({ id }) => id);
    // Replica mode skips FK cascades too, so every referencing row is deleted explicitly.
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["platform.product_audit_events", "pms.property_navigation_modules"])
      await client.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [ids]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// pg-pool resolves end() before its clients close; wait so dropping the login kills nothing live.
async function waitForSessionsToEnd(admin: pg.Pool, login: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ sessions: number }>(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename=$1",
      [login],
    );
    if ((result.rows[0]?.sessions ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test login sessions still open after 5s; not dropping the login");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
