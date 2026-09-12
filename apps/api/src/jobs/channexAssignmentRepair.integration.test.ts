import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { importChannexStagingReservation, runChannexBookingJobs } from "./channexBookings.js";
import {
  seedChannexAssignmentFixture,
  clearChannexAssignmentFixture,
} from "./channexAssignmentTestFixture.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
describe.skipIf(!url)("Channex operational handoff and repair", () => {
  const db = new pg.Pool({ connectionString: url, max: 4 }),
    propertyId = randomUUID(),
    providerPropertyId = randomUUID();
  const config = {
    ...loadConfig({
      TARGET_DATABASE_URL: url,
      API_BACKGROUND_WORKERS_ENABLED: "false",
      PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "test",
      PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: propertyId,
    }),
    apiRuntime: "next" as const,
  };
  let roomId: string;
  beforeAll(async () => {
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Assignment test')",
      [propertyId],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [propertyId, providerPropertyId],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES($1,'channex','connected',$2)",
      [propertyId, providerPropertyId],
    );
    roomId = (await seedChannexAssignmentFixture(db, propertyId)).room;
  });
  afterAll(async () => {
    await db.query("BEGIN;SET LOCAL session_replication_role=replica");
    await clearChannexAssignmentFixture(db, propertyId);
    for (const table of [
      "platform.product_audit_events",
      "platform.dead_letter_events",
      "platform.job_attempts",
    ])
      await db.query(
        `DELETE FROM ${table} WHERE job_id IN(SELECT id FROM platform.jobs WHERE payload->>'propertyId'=$1)`,
        [propertyId],
      );
    await db.query("DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId]);
    await db.query(
      "DELETE FROM booking.booking_guests WHERE guest_booking_id IN(SELECT id FROM booking.guest_bookings WHERE property_id=$1)",
      [propertyId],
    );
    for (const table of [
      "pms.channel_booking_mappings",
      "booking.guest_bookings",
      "pms.channel_connections",
      "pms.channel_binding_claims",
    ])
      await db.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
    await db.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await db.query("COMMIT");
    await db.end();
  });
  async function fixtureSql(sql: string, values: string[]) {
    const client = await db.connect();
    try {
      await client.query("BEGIN;SET LOCAL session_replication_role=replica");
      await client.query(sql, values);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  function fixture(count = 1) {
    const input = {
      providerPropertyId,
      channelBookingId: randomUUID(),
      revision: randomUUID(),
      approvalRef: "VAY-1981:test",
    };
    const revision = {
      id: input.revision,
      attributes: {
        property_id: providerPropertyId,
        booking_id: input.channelBookingId,
        status: "new",
        ota_name: "BookingCom",
        arrival_date: "2026-09-12",
        departure_date: "2026-09-13",
        amount: "100",
        currency: "EUR",
        inserted_at: "2026-09-12T10:00:00Z",
        rooms: Array.from({ length: count }, () => ({
          room_type_id: "provider-room",
          rate_plan_id: "provider-rate",
          occupancy: { adults: 1, children: 0 },
        })),
      },
    };
    let acks = 0;
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === "POST") {
        acks++;
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: revision });
    };
    return { input, revision, request, acks: () => acks };
  }
  async function assignments(booking: string) {
    return (
      await db.query(
        `SELECT a.*,a.check_in::text AS stay_start FROM pms.operational_booking_assignments a JOIN booking.guest_bookings b ON b.id=a.guest_booking_id WHERE b.source_booking_id=$1 ORDER BY a.position`,
        [`channex:${propertyId}:${booking}`],
      )
    ).rows;
  }
  async function inventory() {
    return (
      await db.query(
        "SELECT stay_date::text,assigned_count,available_count,inventory_revision FROM pms.inventory_days WHERE property_id=$1 ORDER BY stay_date",
        [propertyId],
      )
    ).rows;
  }
  async function update(f: ReturnType<typeof fixture>, status = "modified", replay = false) {
    if (!replay) f.revision.id = randomUUID();
    f.revision.attributes.status = status;
    f.revision.attributes.inserted_at = "2026-09-12T11:00:00Z";
    await db.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,payload,max_attempts)
      VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,$3,1)`,
      [
        randomUUID(),
        f.input.channelBookingId,
        {
          propertyId,
          providerPropertyId,
          channelBookingId: f.input.channelBookingId,
          revision: f.revision.id,
          revisionSource: "revision_feed",
          pullRequired: false,
          rawPayload: { event: "booking", payload: f.revision },
        },
      ],
    );
    return runChannexBookingJobs(url!, {
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "test",
      ownsMutation: () => true,
      fetch: f.request,
      limit: 1,
    });
  }
  it("imports exact pending rooms atomically, counts occupancy once and links mapping IDs", async () => {
    const f = fixture(2),
      before = await inventory();
    expect(await importChannexStagingReservation(config, f.input, f.request)).toMatchObject({
      status: "succeeded",
    });
    const rows = await assignments(f.input.channelBookingId);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((a) => [a.position, a.assignment_status, a.room_id, a.source, a.stay_evidence_kind]),
    ).toEqual([
      [1, "pending", null, "channel", "exact"],
      [2, "pending", null, "channel", "exact"],
    ]);
    const day = (await inventory()).find((d) => d.stay_date === "2026-09-12")!;
    expect(day.assigned_count).toBe(
      before.find((d) => d.stay_date === "2026-09-12")!.assigned_count + 2,
    );
    expect(
      (
        await db.query(
          "SELECT assignment_id FROM pms.channel_booking_mappings WHERE guest_booking_id=$1 ORDER BY channel_room_index",
          [rows[0].guest_booking_id],
        )
      ).rows.map((r) => r.assignment_id),
    ).toEqual(rows.map((r) => r.id));
    const snapshot = await inventory();
    await importChannexStagingReservation(config, f.input, f.request);
    expect(await assignments(f.input.channelBookingId)).toEqual(rows);
    expect(await inventory()).toEqual(snapshot);
    expect(f.acks()).toBe(1);
  });
  it("repairs an acknowledged legacy booking once under concurrent calls and preserves staff edits", async () => {
    const f = fixture();
    expect(await importChannexStagingReservation(config, f.input, f.request)).toMatchObject({
      status: "succeeded",
    });
    const original = (await assignments(f.input.channelBookingId))[0];
    // Simulate the pre-VAY-1981 persisted shape in the isolated test database.
    await db.query("DELETE FROM pms.operational_booking_assignments WHERE guest_booking_id=$1", [
      original.guest_booking_id,
    ]);
    await db.query(
      "UPDATE pms.inventory_days SET assigned_count=assigned_count-1,available_count=available_count+1,inventory_revision=inventory_revision+1,booking_source_revision=booking_source_revision+1 WHERE property_id=$1 AND stay_date='2026-09-12'",
      [propertyId],
    );
    const jobs = (
      await db.query("SELECT * FROM platform.jobs WHERE resource_id=$1", [f.input.channelBookingId])
    ).rows;
    const results = await Promise.all(
      [1, 2].map(() =>
        importChannexStagingReservation(config, { ...f.input, repairAssignments: true }, f.request),
      ),
    );
    expect(results.map((r) => "repaired" in r && r.repaired).sort()).toEqual([false, true]);
    expect(await assignments(f.input.channelBookingId)).toHaveLength(1);
    expect(
      (
        await db.query("SELECT * FROM platform.jobs WHERE resource_id=$1", [
          f.input.channelBookingId,
        ])
      ).rows,
    ).toEqual(jobs);
    await db.query(
      'UPDATE pms.operational_booking_assignments SET assignment_payload=assignment_payload||\'{"version":"staff-edit","operationalStatus":"no_show"}\' WHERE guest_booking_id=$1',
      [original.guest_booking_id],
    );
    const staff = await assignments(f.input.channelBookingId),
      inv = await inventory();
    expect(
      await importChannexStagingReservation(
        config,
        { ...f.input, repairAssignments: true },
        f.request,
      ),
    ).toMatchObject({ repaired: false });
    expect(await assignments(f.input.channelBookingId)).toEqual(staff);
    expect(await inventory()).toEqual(inv);
    expect(f.acks()).toBe(1);
  });
  it("rejects partial repair and preserves physical allocation on contact-only changes", async () => {
    const partial = fixture(2);
    await importChannexStagingReservation(config, partial.input, partial.request);
    const rows = await assignments(partial.input.channelBookingId);
    await db.query("DELETE FROM pms.operational_booking_assignments WHERE id=$1", [rows[1].id]);
    await expect(
      importChannexStagingReservation(
        config,
        { ...partial.input, repairAssignments: true },
        partial.request,
      ),
    ).rejects.toThrow("operational_assignment_conflict");
    const f = fixture();
    await importChannexStagingReservation(config, f.input, f.request);
    const row = (await assignments(f.input.channelBookingId))[0];
    const physical = (
      await db.query(
        "INSERT INTO pms.rooms(property_id,room_type_id,room_number) VALUES($1,$2,'1981') RETURNING id",
        [propertyId, roomId],
      )
    ).rows[0].id;
    await db.query(
      "UPDATE pms.operational_booking_assignments SET room_id=$2,assignment_status='assigned',assignment_payload=assignment_payload||jsonb_build_object('version','staff') WHERE id=$1",
      [row.id, physical],
    );
    const staff = await assignments(f.input.channelBookingId);
    f.revision.attributes.amount = "120";
    expect(await update(f)).toMatchObject({ succeeded: 1 });
    expect(await assignments(f.input.channelBookingId)).toEqual(staff);
    await db.query(
      "UPDATE pms.operational_booking_assignments SET assignment_status='checked_in' WHERE id=$1",
      [row.id],
    );
    const checkedIn = await assignments(f.input.channelBookingId);
    expect(await update(f, "cancelled")).toMatchObject({ deadLettered: 1 });
    expect(await assignments(f.input.channelBookingId)).toEqual(checkedIn);
    expect(
      (
        await db.query("SELECT lifecycle_status FROM booking.guest_bookings WHERE id=$1", [
          row.guest_booking_id,
        ])
      ).rows[0].lifecycle_status,
    ).toBe("confirmed");
  });
  it("shrinks and grows pending rooms and rejects incomplete inventory coverage", async () => {
    const f = fixture(2);
    await importChannexStagingReservation(config, f.input, f.request);
    f.revision.attributes.rooms.pop();
    expect(await update(f)).toMatchObject({ succeeded: 1 });
    expect(await assignments(f.input.channelBookingId)).toHaveLength(1);
    f.revision.attributes.rooms.push({ ...f.revision.attributes.rooms[0]! });
    expect(await update(f)).toMatchObject({ succeeded: 1 });
    const rows = await assignments(f.input.channelBookingId);
    expect(rows).toHaveLength(2);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM pms.channel_booking_mappings WHERE guest_booking_id=$1 AND sync_status='active' AND assignment_id IS NOT NULL",
          [rows[0].guest_booking_id],
        )
      ).rows[0].n,
    ).toBe(2);
    const missing = fixture();
    missing.revision.attributes.arrival_date = "2026-10-01";
    missing.revision.attributes.departure_date = "2026-10-02";
    expect(
      await importChannexStagingReservation(config, missing.input, missing.request),
    ).toMatchObject({ status: "pending", failureCode: "operational_inventory_unavailable" });
    expect(await assignments(missing.input.channelBookingId)).toEqual([]);
    expect(missing.acks()).toBe(0);
  });
  it("rejects mapping and closed inventory failures without partial bookings or ACKs", async () => {
    for (const invalid of ["missing", "stale", "closed", "inactive", "capacity"]) {
      const f = fixture(2);
      if (invalid === "missing") f.revision.attributes.rooms[1]!.rate_plan_id = "unmapped";
      if (invalid === "stale")
        await db.query(
          "UPDATE pms.channel_rate_plan_mappings SET status='stale' WHERE property_id=$1",
          [propertyId],
        );
      if (invalid === "closed")
        await fixtureSql(
          "UPDATE pms.inventory_days SET status='closed',available_count=0 WHERE property_id=$1 AND stay_date='2026-09-12'",
          [propertyId],
        );
      if (invalid === "inactive")
        await db.query("UPDATE pms.room_types SET active=false WHERE id=$1", [roomId]);
      if (invalid === "capacity")
        await fixtureSql(
          "UPDATE pms.inventory_days SET blocked_count=total_count-assigned_count,available_count=0 WHERE property_id=$1 AND stay_date='2026-09-12'",
          [propertyId],
        );
      const before = await inventory();
      expect(await importChannexStagingReservation(config, f.input, f.request)).toMatchObject({
        status: invalid === "capacity" ? "pending" : "dead_lettered",
      });
      expect(await assignments(f.input.channelBookingId)).toEqual([]);
      expect(f.acks()).toBe(0);
      expect(await inventory()).toEqual(before);
      expect(
        (
          await db.query("SELECT id FROM booking.guest_bookings WHERE source_booking_id=$1", [
            `channex:${propertyId}:${f.input.channelBookingId}`,
          ])
        ).rowCount,
      ).toBe(0);
      await db.query(
        "UPDATE pms.channel_rate_plan_mappings SET status='active' WHERE property_id=$1",
        [propertyId],
      );
      await db.query("UPDATE pms.room_types SET active=true WHERE id=$1", [roomId]);
      await fixtureSql(
        "UPDATE pms.inventory_days SET status='open',blocked_count=0,available_count=total_count-assigned_count WHERE property_id=$1",
        [propertyId],
      );
    }
  });
  it("moves untouched stays and releases cancellation occupancy; rejects staff-conflicting changes", async () => {
    const f = fixture(2);
    await importChannexStagingReservation(config, f.input, f.request);
    const before = await inventory();
    f.revision.attributes.arrival_date = "2026-09-14";
    f.revision.attributes.departure_date = "2026-09-15";
    expect(await update(f)).toMatchObject({ succeeded: 1 });
    const changed = await assignments(f.input.channelBookingId);
    expect(changed.map((a) => a.stay_start)).toEqual(["2026-09-14", "2026-09-14"]);
    expect((await inventory()).find((d) => d.stay_date === "2026-09-12")!.assigned_count).toBe(
      before.find((d) => d.stay_date === "2026-09-12")!.assigned_count - 2,
    );
    expect(await update(f, "cancelled")).toMatchObject({ succeeded: 1 });
    expect((await assignments(f.input.channelBookingId)).map((a) => a.assignment_status)).toEqual([
      "canceled",
      "canceled",
    ]);
    expect((await inventory()).find((d) => d.stay_date === "2026-09-14")!.assigned_count).toBe(0);
    const canceled = await assignments(f.input.channelBookingId),
      canceledInventory = await inventory();
    expect(await update(f, "cancelled", true)).toMatchObject({ succeeded: 1 });
    expect(await assignments(f.input.channelBookingId)).toEqual(canceled);
    expect(await inventory()).toEqual(canceledInventory);
    const touched = fixture();
    await importChannexStagingReservation(config, touched.input, touched.request);
    const booking = (await assignments(touched.input.channelBookingId))[0].guest_booking_id;
    await db.query(
      'UPDATE pms.operational_booking_assignments SET assignment_payload=assignment_payload||\'{"version":"staff"}\' WHERE guest_booking_id=$1',
      [booking],
    );
    const stable = await assignments(touched.input.channelBookingId);
    touched.revision.attributes.departure_date = "2026-09-14";
    expect(await update(touched)).toMatchObject({ deadLettered: 1 });
    expect(await assignments(touched.input.channelBookingId)).toEqual(stable);
  });
});
