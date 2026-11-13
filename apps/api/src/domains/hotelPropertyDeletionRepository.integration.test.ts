import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../hotelSetupOrdinaryLogin.fixture.js";
import { createPgSharedHotelSetupStatusRepository } from "../platform/sharedHotelSetupStatusReadModel.js";
import {
  createPgHotelPropertyDeletionRepository,
  type HotelPropertyDeletionCommand,
  type HotelPropertyDeletionRepository,
} from "./hotelPropertyDeletionRepository.js";

// VAY-2493: the account admin deletes (retires) one of the account's properties. The repository runs
// on the ordinary API login, as in production; fixture rows are written by the test's own login.
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const run = randomUUID().slice(0, 8);
const organizationId = randomUUID();
const adminUserId = randomUUID();
const staffUserId = randomUUID();
const propertyA = randomUUID();
const propertyB = randomUUID();
const properties = [
  { id: propertyA, name: "Escape Villa" },
  { id: propertyB, name: "Dewari Villa" },
] as const;
// 20:00 UTC on 13 Nov is already 14 Nov in Bali (UTC+8).
const now = new Date("2026-11-13T20:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("hotel property deletion on PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let repository: HotelPropertyDeletionRepository;
  let statusRepository: ReturnType<typeof createPgSharedHotelSetupStatusRepository>;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 4 });
    repository = createPgHotelPropertyDeletionRepository({ pool, now: () => now });
    statusRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: fixture.connectionString,
      max: 1,
    });
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $3, 'Account Admin', 'active'), ($2::uuid, $4, 'Front Desk', 'active')`,
      [adminUserId, staffUserId, `admin-${run}@example.test`, `staff-${run}@example.test`],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Travel Ubud Test', $2, 'active')`,
      [organizationId, `travel-ubud-${run}`],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin, property_access_mode
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency', 'all'),
                ($1::uuid, $3::uuid, 'active', 'hotel_manager', 'agency', 'all')`,
      [organizationId, adminUserId, staffUserId],
    );
    for (const property of properties) {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (
           id, public_id, display_name, profile_status, lifecycle_status, lifecycle_revision
         ) VALUES ($1::uuid, $2, $3, 'complete', 'active', 1)`,
        [property.id, `prop_delete_${run}_${property.id.slice(0, 4)}`, property.name],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Asia/Makassar')`,
        [property.id],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
        [organizationId, property.id],
      );
    }
  });

  afterAll(async () => {
    await repository?.close();
    await statusRepository?.close?.();
    await pool?.end();
    await fixture?.drop();
    await cleanup();
    await admin.end();
  });

  beforeEach(async () => {
    await inReplicaMode(async () => {
      for (const table of [
        "booking.guest_bookings",
        "pms.channel_connections",
        "finance.payments",
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "distribution.active_public_booking_revision",
        "distribution.public_booking_content_revisions",
      ]) {
        await admin.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          [propertyA, propertyB],
        ]);
      }
      await admin.query(
        `UPDATE hotel_catalog.properties
         SET lifecycle_status = 'active', lifecycle_revision = 1, profile_status = 'complete',
             pre_hold_profile_status = NULL, retired_at = NULL, retired_by_user_id = NULL
         WHERE id = ANY($1::uuid[])`,
        [[propertyA, propertyB]],
      );
    });
  });

  it("lets only the account admin check or delete", async () => {
    await expect(
      repository.check({ organizationId, actorUserId: staffUserId, propertyId: propertyA }),
    ).rejects.toMatchObject({ code: "account_admin_required" });
    await expect(
      repository.delete(command(propertyA, { actorUserId: staffUserId })),
    ).rejects.toMatchObject({ code: "account_admin_required" });
    await expect(lifecycle(propertyA)).resolves.toMatchObject({ status: "active" });
  });

  it("retires the property, takes its booking page offline and hides it from the switcher", async () => {
    await publishBookingPage(propertyA);
    await expect(
      repository.check({ organizationId, actorUserId: adminUserId, propertyId: propertyA }),
    ).resolves.toEqual({
      contractVersion: "hotel-property-deletion.v1",
      propertyId: propertyA,
      displayName: "Escape Villa",
      lifecycleRevision: 1,
      accountProperties: 2,
      blockers: [],
      canDelete: true,
    });

    const deletion = command(propertyA);
    const [first, replay] = await Promise.all([
      repository.delete(deletion),
      repository.delete(deletion),
    ]);
    expect(first).toEqual({
      contractVersion: "platform-property-lifecycle.v1",
      propertyId: propertyA,
      lifecycleStatus: "retired",
      lifecycleRevision: 2,
    });
    expect(replay).toEqual(first);

    await expect(lifecycle(propertyA)).resolves.toEqual({
      status: "retired",
      profile_status: "disabled",
      retired_by: adminUserId,
      live_page: false,
      audits: 1,
      keys: 1,
    });
    await expect(lifecycle(propertyB)).resolves.toMatchObject({ status: "active" });
    const status = await statusRepository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyA, propertyB],
    });
    expect(status.properties.map((property) => property.propertyId)).toEqual([propertyB]);
    // Gone from the admin's list too: checking it again answers "not found".
    await expect(
      repository.check({ organizationId, actorUserId: adminUserId, propertyId: propertyA }),
    ).resolves.toBeNull();
    await expect(
      repository.delete(command(propertyA, { idempotencyKey: `again-${run}` })),
    ).rejects.toMatchObject({ code: "property_already_deleted" });
  });

  it("never deletes the account's last property", async () => {
    await repository.delete(command(propertyA));

    await expect(
      repository.check({ organizationId, actorUserId: adminUserId, propertyId: propertyB }),
    ).resolves.toMatchObject({
      accountProperties: 1,
      blockers: [{ code: "last_property", count: 1 }],
      canDelete: false,
    });
    await expect(repository.delete(command(propertyB))).rejects.toMatchObject({
      code: "deletion_blocked",
      check: { blockers: [{ code: "last_property", count: 1 }] },
    });
    await expect(lifecycle(propertyB)).resolves.toMatchObject({ status: "active" });
  });

  it("keeps one property when both are deleted at the same moment", async () => {
    // Hold both rows so the two deletes start together and wait at the same lock.
    const holder = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT id FROM hotel_catalog.properties WHERE id = ANY($1::uuid[]) FOR SHARE",
        [[propertyA, propertyB]],
      );
      const deletes = Promise.allSettled([
        repository.delete(command(propertyA)),
        repository.delete(command(propertyB)),
      ]);
      await waitForLockWaiters(2);
      await holder.query("COMMIT");

      const [a, b] = await deletes;
      const outcomes = [a, b].map((result) => result.status);
      expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
      const refused = [a, b].find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({
        code: "deletion_blocked",
        check: { blockers: [{ code: "last_property", count: 1 }] },
      });
      const statuses = await Promise.all([lifecycle(propertyA), lifecycle(propertyB)]);
      expect(statuses.map((row) => row.status).sort()).toEqual(["active", "retired"]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("waits for an in-flight booking writer and is blocked by its upcoming booking", async () => {
    const booking = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await booking.connect();
    try {
      await booking.query("BEGIN");
      await booking.query(
        `SELECT id FROM hotel_catalog.properties
         WHERE id = $1::uuid AND lifecycle_status = 'active' FOR SHARE`,
        [propertyA],
      );
      const deletion = repository.delete(command(propertyA));
      await waitForLockWaiters(1);
      await insertBooking(booking, propertyA, "confirmed", "2026-12-01", "2026-12-03");
      await booking.query("COMMIT");

      await expect(deletion).rejects.toMatchObject({
        code: "deletion_blocked",
        check: { blockers: [{ code: "upcoming_bookings", count: 1 }] },
      });
      await expect(lifecycle(propertyA)).resolves.toMatchObject({ status: "active" });
    } finally {
      await booking.query("ROLLBACK").catch(() => undefined);
      await booking.end();
    }
  });

  it("is blocked by stays that have not ended, a connected channel and open payments only", async () => {
    // None of these block: an ended stay (checked out yesterday in Bali, today in UTC), an
    // unfinished checkout, a cancelled booking and a disconnected channel.
    await insertBooking(admin, propertyA, "confirmed", "2026-11-10", "2026-11-13");
    await insertBooking(admin, propertyA, "draft", "2026-12-01", "2026-12-02");
    await insertBooking(admin, propertyA, "canceled", "2026-12-01", "2026-12-02");
    await admin.query(
      `INSERT INTO pms.channel_connections (property_id, provider, connection_status)
       VALUES ($1::uuid, 'channex', 'disconnected')`,
      [propertyA],
    );
    await expect(checkA()).resolves.toMatchObject({ blockers: [], canDelete: true });

    // A guest checking out today (Bali time), and a connected channel, block.
    await insertBooking(admin, propertyA, "confirmed", "2026-11-12", "2026-11-14");
    await insertBooking(admin, propertyA, "pending_payment", "2026-12-20", "2026-12-22");
    await admin.query(
      `UPDATE pms.channel_connections SET connection_status = 'connected'
       WHERE property_id = $1::uuid`,
      [propertyA],
    );
    await expect(checkA()).resolves.toMatchObject({
      blockers: [
        { code: "upcoming_bookings", count: 2 },
        { code: "connected_channels", count: 1 },
      ],
      canDelete: false,
    });
    await expect(repository.delete(command(propertyA))).rejects.toMatchObject({
      code: "deletion_blocked",
    });
  });

  it("refuses a wrong typed name and a stale revision", async () => {
    await expect(
      repository.delete(command(propertyA, { confirmationName: "escape villa" })),
    ).rejects.toMatchObject({ code: "confirmation_name_mismatch" });
    await expect(
      repository.delete(command(propertyA, { expectedLifecycleRevision: 7 })),
    ).rejects.toMatchObject({
      code: "lifecycle_revision_conflict",
      check: { lifecycleRevision: 1 },
    });
    // Spaces around the typed name are fine.
    await expect(
      repository.delete(command(propertyA, { confirmationName: "  Escape Villa " })),
    ).resolves.toMatchObject({ lifecycleStatus: "retired" });
  });

  function command(
    propertyId: string,
    overrides: Partial<HotelPropertyDeletionCommand> = {},
  ): HotelPropertyDeletionCommand {
    return {
      organizationId,
      actorUserId: adminUserId,
      propertyId,
      expectedLifecycleRevision: 1,
      confirmationName: properties.find((property) => property.id === propertyId)!.name,
      idempotencyKey: `delete-${run}-${propertyId}`,
      audit: {
        requestId: `req-${run}`,
        correlationId: `corr-${run}`,
        requestedAt: now.toISOString(),
      },
      ...overrides,
    };
  }

  function checkA() {
    return repository.check({ organizationId, actorUserId: adminUserId, propertyId: propertyA });
  }

  async function lifecycle(propertyId: string) {
    const result = await admin.query(
      `SELECT property.lifecycle_status AS status,
              property.profile_status,
              property.retired_by_user_id::text AS retired_by,
              EXISTS (SELECT 1 FROM distribution.active_public_booking_revision live
                      WHERE live.property_id = property.id) AS live_page,
              (SELECT count(*)::int FROM platform.product_audit_events audit
               WHERE audit.property_id = property.id
                 AND audit.action = 'hotel_catalog.property.account_delete') AS audits,
              (SELECT count(*)::int FROM platform.idempotency_keys key
               WHERE key.property_id = property.id
                 AND key.operation = 'hotel_catalog.property.account_delete') AS keys
       FROM hotel_catalog.properties property WHERE property.id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0];
  }

  async function publishBookingPage(propertyId: string) {
    const revisionId = randomUUID();
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version, source_manifest,
         source_manifest_hash, readiness_hash, readiness_product, readiness_status, public_content,
         built_by_user_id
       ) VALUES ($1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1', $3::jsonb, $4, $5,
         'booking', 'ready', '{}'::jsonb, $6::uuid)`,
      [
        revisionId,
        propertyId,
        JSON.stringify({
          contractVersion: "onboarding-source-manifest.v1",
          propertyId,
          sources: [{ owner: "hotel_catalog", entityId: propertyId, revision: "1" }],
        }),
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        adminUserId,
      ],
    );
    await admin.query(
      `INSERT INTO distribution.active_public_booking_revision
         (property_id, content_revision_id, activated_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [propertyId, revisionId, adminUserId],
    );
  }

  async function insertBooking(
    client: pg.Client,
    propertyId: string,
    lifecycleStatus: string,
    checkIn: string,
    checkOut: string,
  ) {
    await client.query(
      `INSERT INTO booking.guest_bookings (
         property_id, public_reference, lifecycle_status, payment_status, check_in, check_out, currency
       ) VALUES ($1::uuid, $2, $3, 'unpaid', $4::date, $5::date, 'EUR')`,
      [propertyId, `DEL-${run}-${randomUUID().slice(0, 8)}`, lifecycleStatus, checkIn, checkOut],
    );
  }

  async function waitForLockWaiters(expected: number) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const result = await admin.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE '%FOR NO KEY UPDATE OF property%'`,
      );
      if ((result.rows[0]?.waiting ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Expected ${expected} deletes waiting for the property lock`);
  }

  async function inReplicaMode(work: () => Promise<void>) {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await work();
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function cleanup() {
    const ids = [propertyA, propertyB];
    await inReplicaMode(async () => {
      for (const table of [
        "booking.guest_bookings",
        "pms.channel_connections",
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "distribution.public_hotel_bookability_profiles",
        "distribution.active_public_booking_revision",
        "distribution.public_booking_content_revisions",
        "hotel_catalog.property_locations",
      ]) {
        await admin.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [ids]);
      }
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [ids]);
    });
  }
});

function assertSafeTestDatabase(url: string): void {
  const endpoint = new URL(url);
  const databaseName = endpoint.pathname.replace(/^\//, "");
  // The fixture creates a login role, so only a local test database will do.
  if (
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    !/(^|[_-])test([_-]|$)/i.test(databaseName)
  ) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
