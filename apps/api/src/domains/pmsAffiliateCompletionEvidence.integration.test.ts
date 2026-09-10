import { createPgPmsAffiliateCompletionRepository } from "./pmsAffiliateCompletionRepository.js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { beforeAll, beforeEach, afterAll, expect, it, describe } from "vitest";
import { readPmsAffiliateCompletionEvidence as read } from "./pmsAffiliateCompletionEvidence.js";
const databaseUrl = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `15050000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function context(): RequestContext {
  return {
    actor: {
      internalUserId: id(1),
      status: "active",
      email: "test@example.test",
      providerIdentity: { provider: "workos", providerUserId: "user-test" },
    },
    selectedOrganization: { organizationId: id(4), kind: "hotel_group", status: "active" },
    membership: {
      membershipId: id(8),
      status: "active",
      roleKey: "owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.profile.manage"],
    },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: id(3),
        status: "active",
        relationship: "owner",
      },
    ],
    entitlements: [{ product: "marketplace", key: "marketplace-hotel-profile", status: "active" }],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt: new Date().toISOString() },
  };
}

describe.skipIf(!databaseUrl)("PMS affiliate completion evidence", () => {
  const name = `vay1505_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  let pool: pg.Pool;
  let isolatedUrl: string;
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(databaseUrl!).pathname.slice(1)))
      throw new Error("Isolated test database required");
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    isolatedUrl = url.toString();
    pool = new pg.Pool({ connectionString: isolatedUrl });
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS pms,booking,hotel_catalog,identity,platform CASCADE;
      CREATE SCHEMA pms;CREATE SCHEMA booking;CREATE SCHEMA hotel_catalog;CREATE SCHEMA identity;CREATE SCHEMA platform;
      CREATE TABLE hotel_catalog.properties(id UUID,profile_status TEXT);
      CREATE TABLE identity.organization_resource_links(organization_id UUID,product TEXT,resource_type TEXT,resource_id TEXT,status TEXT,relationship TEXT);
      CREATE TABLE booking.guest_bookings(id UUID,property_id UUID,lifecycle_status TEXT);
      CREATE TABLE pms.operational_booking_assignments(id UUID,property_id UUID,guest_booking_id UUID,assignment_status TEXT, UNIQUE(id,property_id,guest_booking_id));
      CREATE TABLE pms.booking_checkout_records(id UUID,property_id UUID,guest_booking_id UUID,assignment_id UUID,completed_at TIMESTAMPTZ,completed_by_user_id UUID,pending_flags JSONB, FOREIGN KEY(assignment_id,property_id,guest_booking_id) REFERENCES pms.operational_booking_assignments(id,property_id,guest_booking_id) ON DELETE SET NULL(assignment_id));
      CREATE TABLE platform.product_audit_events(id UUID,product TEXT,action TEXT,action_version INT,tenant_scope TEXT,property_id UUID,target_resource_product TEXT,target_resource_type TEXT,target_resource_id TEXT,secondary_resource_product TEXT,secondary_resource_type TEXT,secondary_resource_id TEXT,actor_type TEXT,actor_user_id UUID,occurred_at TIMESTAMPTZ,causation_id TEXT);`);
    await pool.query("INSERT INTO hotel_catalog.properties VALUES($1,'active')", [id(3)]);
    await pool.query(
      "INSERT INTO identity.organization_resource_links VALUES($1,'marketplace','hotel_profile',$2,'active','owner')",
      [id(4), id(3)],
    );
    await pool.query("INSERT INTO booking.guest_bookings VALUES($1,$2,'confirmed')", [
      id(10),
      id(3),
    ]);
    await pool.query(
      "INSERT INTO pms.operational_booking_assignments VALUES($1,$2,$3,'checked_out')",
      [id(11), id(3), id(10)],
    );
    await pool.query(
      "INSERT INTO pms.booking_checkout_records VALUES($1,$2,$3,$4,'2026-01-01T12:00:00Z',$5,'[\"inspection_pending\"]')",
      [id(12), id(3), id(10), id(11), id(1)],
    );
    await pool.query(
      `INSERT INTO platform.product_audit_events VALUES($1,'pms','pms.checkout.completed',1,'property',$2,'pms','booking_checkout_record',$3,'booking','guest_booking',$4,'user',$5,'2026-01-01T12:00:00Z','checkout-command')`,
      [id(13), id(3), id(12), id(10), id(1)],
    );
  });
  const input = () => ({
    context: context(),
    propertyId: id(3),
    bookingId: id(10),
    stayItemId: id(11),
  });
  it("reads repeatable hotel assertion with provenance, no invented actual departure or private data", async () => {
    const result = await read(pool, input());
    expect(result).toEqual({
      status: "completed",
      propertyId: id(3),
      bookingId: id(10),
      stayItemId: id(11),
      source: "vayada_pms",
      assertion: "authenticated_hotel_checkout",
      sourceRecordId: id(12),
      auditEventId: id(13),
      actorUserId: id(1),
      causedByCommandId: "checkout-command",
      recordedAt: "2026-01-01T12:00:00.000Z",
      actualDepartureAt: null,
      hasPendingFlags: true,
    });
    const repository = createPgPmsAffiliateCompletionRepository(isolatedUrl);
    try {
      expect(await repository.read(input())).toEqual(result);
    } finally {
      await repository.close();
    }
  });
  it.each([
    "DELETE FROM pms.booking_checkout_records",
    "DELETE FROM platform.product_audit_events",
    "UPDATE platform.product_audit_events SET actor_user_id='15050000-0000-4000-8000-000000000099'",
    "UPDATE platform.product_audit_events SET property_id='15050000-0000-4000-8000-000000000099'",
    "UPDATE pms.operational_booking_assignments SET assignment_status='in_house'",
    "UPDATE booking.guest_bookings SET lifecycle_status='canceled'",
    "UPDATE platform.product_audit_events SET actor_type='system'",
    "UPDATE platform.product_audit_events SET causation_id=NULL",
    "UPDATE platform.product_audit_events SET occurred_at='2025-01-01'",
    "UPDATE pms.booking_checkout_records SET completed_at='2099-01-01'",
  ])("keeps absent/conflicting provenance pending: %s", async (sql) => {
    await pool.query(sql);
    expect(await read(pool, input())).toEqual({
      status: "pending",
      reason: "completion_unconfirmed",
    });
  });
  it("keeps missing item references pending even when only one item remains", async () => {
    await pool.query("UPDATE pms.booking_checkout_records SET assignment_id=NULL");
    expect(await read(pool, input())).toMatchObject({ status: "pending" });
    await pool.query(
      "INSERT INTO pms.operational_booking_assignments VALUES($1,$2,$3,'in_house')",
      [id(14), id(3), id(10)],
    );
    expect(await read(pool, input())).toMatchObject({ status: "pending" });
    await pool.query("UPDATE pms.booking_checkout_records SET assignment_id=$1", [id(11)]);
    expect(await read(pool, input())).toMatchObject({ status: "completed" });
    expect(await read(pool, { ...input(), stayItemId: id(14) })).toMatchObject({
      status: "pending",
    });
  });
  it("does not transfer deleted-item checkout evidence to a remaining item", async () => {
    await pool.query(
      "INSERT INTO pms.operational_booking_assignments VALUES($1,$2,$3,'checked_out')",
      [id(14), id(3), id(10)],
    );
    await pool.query("DELETE FROM pms.operational_booking_assignments WHERE id=$1", [id(11)]);
    expect(
      (await pool.query("SELECT assignment_id FROM pms.booking_checkout_records")).rows[0]
        .assignment_id,
    ).toBeNull();
    expect(await read(pool, { ...input(), stayItemId: id(14) })).toEqual({
      status: "pending",
      reason: "completion_unconfirmed",
    });
  });
  it("requires fresh permissions and persisted property scope on every read", async () => {
    for (const mutate of [
      (c: RequestContext) => {
        c.membership.permissions = [];
      },
      (c: RequestContext) => {
        c.entitlements = [];
      },
      (c: RequestContext) => {
        c.linkedResources = [];
      },
    ]) {
      const request = input();
      mutate(request.context);
      await expect(read(pool, request)).rejects.toThrow();
    }
    for (const override of [
      { bookingId: id(99) },
      { stayItemId: id(99) },
      { propertyId: "invalid" },
    ])
      expect(await read(pool, { ...input(), ...override })).toEqual({
        status: "pending",
        reason: "scope_unavailable",
      });
    await pool.query("UPDATE identity.organization_resource_links SET status='revoked'");
    expect(await read(pool, input())).toEqual({ status: "pending", reason: "scope_unavailable" });
  });
  it.each([
    "UPDATE hotel_catalog.properties SET profile_status='disabled'",
    "UPDATE identity.organization_resource_links SET organization_id='15050000-0000-4000-8000-000000000099'",
  ])("rejects persisted scope loss: %s", async (sql) => {
    await pool.query(sql);
    expect(await read(pool, input())).toEqual({ status: "pending", reason: "scope_unavailable" });
  });
  it("propagates database errors instead of returning confirmation", async () => {
    await pool.query("DROP TABLE platform.product_audit_events");
    await expect(read(pool, input())).rejects.toThrow();
  });
});
