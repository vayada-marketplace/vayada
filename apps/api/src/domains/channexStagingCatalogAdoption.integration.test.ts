import { importChannexStagingReservation } from "../jobs/channexBookings.js";
import {
  seedChannexAssignmentInventory,
  clearChannexAssignmentFixture,
} from "../jobs/channexAssignmentTestFixture.js";
import { persistChannexAssignments } from "./channexBookingAssignments.js";
import { resolveStagingCatalogReference } from "./channexStagingCatalogReference.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptChannexStagingCatalog } from "./channexStagingCatalogAdoption.js";

import {
  databaseUrl,
  propertyId,
  roomId,
  rateId,
  input,
  config,
  provider,
} from "./channexStagingCatalogTestFixture.js";
describe.skipIf(!databaseUrl)("staging catalog transaction", () => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  beforeEach(async () => {
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Catalog test')",
      [propertyId, propertyId],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [propertyId, input.providerPropertyId],
    );
    const connection = (
      await db.query(
        "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1,'channex',$2,'connected') RETURNING id,binding_generation",
        [propertyId, input.providerPropertyId],
      )
    ).rows[0];
    const booking = (
      await db.query(
        `INSERT INTO booking.guest_bookings(property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,check_in,check_out,adults,children,room_count,currency,total_amount,balance_amount,booking_channel)
      VALUES($1,$2,'pms',$3,'confirmed','unpaid','2026-09-12','2026-09-13',2,0,1,'GBP',80,80,'booking_com') RETURNING id`,
        [propertyId, randomUUID(), `channex:${propertyId}:${input.bookingId}`],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,external_revision_id) VALUES($1,$2,$3,$4,$5)",
      [propertyId, connection.id, booking.id, input.bookingId, input.revisionId],
    );
    await db.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,payload,status,job_metadata,finished_at)
      VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,$3,'succeeded',$4,now())`,
      [
        `channex.staging-import:${propertyId}:${input.bookingId}:${input.revisionId}:v1`,
        input.bookingId,
        { propertyId },
        { stagingImport: { bindingGeneration: connection.binding_generation } },
      ],
    );
  });
  afterEach(async () => {
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
    for (const table of [
      "pms.channex_staging_catalog_references",
      "pms.room_type_closures",
      "platform.product_audit_events",
      "pms.channel_rate_plan_mappings",
      "pms.channel_room_type_mappings",
      "pms.rate_plans",
      "pms.room_types",
      "pms.channel_booking_mappings",
      "booking.guest_bookings",
      "pms.channel_connections",
      "pms.channel_binding_claims",
    ])
      await db.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
    await clearChannexAssignmentFixture(db, propertyId);
    await db.query("DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId]);
    await db.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await db.query("COMMIT");
  });
  afterAll(() => db.end());
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of [
      "pms.room_types",
      "pms.channex_staging_catalog_references",
      "pms.rate_plans",
      "pms.channel_room_type_mappings",
      "pms.channel_rate_plan_mappings",
      "pms.rooms",
      "pms.inventory_days",
      "pms.operational_booking_assignments",
      "platform.product_audit_events",
      "booking.guest_bookings",
      "pms.channel_booking_mappings",
    ])
      result[table] = (
        await db.query(`SELECT * FROM ${table} WHERE property_id=$1`, [propertyId])
      ).rows;
    result.jobs = (
      await db.query("SELECT * FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId])
    ).rows;
    return result;
  };
  it("previews without writes and applies concurrently once, preserving staff edits and jobs", async () => {
    const { request } = provider(),
      before = await snapshot();
    const preview = await adoptChannexStagingCatalog(config(), input, request);
    expect(preview.outcome).toBe("preview");
    expect(await snapshot()).toEqual(before);
    const results = await Promise.all(
      [1, 2].map(() =>
        adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual(["adopted", "replayed"]);
    const after = await snapshot();
    for (const table of [
      "pms.room_types",
      "pms.channex_staging_catalog_references",
      "pms.channel_room_type_mappings",
      "platform.product_audit_events",
    ])
      expect(after[table]).toHaveLength(1);
    for (const table of [
      "pms.rate_plans",
      "pms.channel_rate_plan_mappings",
      "pms.rooms",
      "pms.inventory_days",
      "pms.operational_booking_assignments",
      "booking.guest_bookings",
      "pms.channel_booking_mappings",
      "jobs",
    ])
      expect(after[table]).toEqual(before[table]);
    await db.query("UPDATE pms.room_types SET name='Staff updated name' WHERE property_id=$1", [
      propertyId,
    ]);
    const edited = await snapshot();
    await expect(
      adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
    ).resolves.toMatchObject({ outcome: "replayed" });
    expect(await snapshot()).toEqual(edited);
    await db.query("UPDATE pms.room_types SET active=false WHERE property_id=$1", [propertyId]);
    await expect(
      adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
    ).rejects.toThrow("staging_catalog_replay_conflict");
  });
  it("rejects changed provider evidence, missing completed import and changed binding without writes", async () => {
    const { data, request } = provider(),
      preview = await adoptChannexStagingCatalog(config(), input, request),
      before = await snapshot();
    data[`room_types/${roomId}`].attributes.title = "Changed";
    await expect(
      adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
    ).rejects.toThrow("staging_catalog_evidence_changed");
    expect(await snapshot()).toEqual(before);
    data[`room_types/${roomId}`].attributes.title = "Synthetic Double";
    await db.query(
      "UPDATE platform.jobs SET status='dead_lettered' WHERE payload->>'propertyId'=$1",
      [propertyId],
    );
    await expect(adoptChannexStagingCatalog(config(), input, request)).rejects.toThrow(
      "completed_staging_import_required",
    );
    await db.query(
      "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
      [propertyId],
    );
    await expect(adoptChannexStagingCatalog(config(), input, request)).rejects.toThrow(
      "staging_catalog_binding_unavailable",
    );
  });
  it("rejects an existing source identity without creating partial mappings or audit", async () => {
    const { request } = provider(),
      preview = await adoptChannexStagingCatalog(config(), input, request);
    await db.query(
      "INSERT INTO pms.room_types(property_id,name,source_room_type_id,currency,base_rate_amount,active) VALUES($1,'Retired room',$2,'GBP',0,false)",
      [propertyId, `channex-staging:${input.providerPropertyId}:${roomId}`],
    );
    const before = await snapshot();
    await expect(
      adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
    ).rejects.toThrow("staging_catalog_mapping_conflict");
    expect(await snapshot()).toEqual(before);
  });
  it("rolls back catalog rows when a later audit write fails", async () => {
    const { request } = provider(),
      preview = await adoptChannexStagingCatalog(config(), input, request);
    const before = await snapshot();
    await db.query(`CREATE FUNCTION pms.vay1981_catalog_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.property_id='${propertyId}'::uuid THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER vay1981_catalog_audit_failure BEFORE INSERT ON platform.product_audit_events
      FOR EACH ROW EXECUTE FUNCTION pms.vay1981_catalog_audit_failure()`);
    try {
      await expect(
        adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
      ).rejects.toThrow("synthetic audit failure");
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER vay1981_catalog_audit_failure ON platform.product_audit_events; DROP FUNCTION pms.vay1981_catalog_audit_failure()",
      );
    }
  });
  it("repairs only the exact staged booking with a reference, retaining EUR pricing and inventory guards", async () => {
    await db.query(
      "INSERT INTO pms.room_types(property_id,name,currency,base_rate_amount) VALUES($1,'Existing EUR room','EUR',100)",
      [propertyId],
    );
    const { request } = provider(),
      preview = await adoptChannexStagingCatalog(config(), input, request);
    const adopted = await adoptChannexStagingCatalog(
      config(),
      { ...input, applyHash: preview.hash },
      request,
    );
    const canonicalRoomId = adopted.roomTypeId!;
    expect(
      (
        await db.query("SELECT currency,base_rate_amount FROM pms.room_types WHERE id=$1", [
          canonicalRoomId,
        ])
      ).rows[0],
    ).toEqual({ currency: null, base_rate_amount: null });
    const bookingId = (
      await db.query("SELECT id FROM booking.guest_bookings WHERE property_id=$1", [propertyId])
    ).rows[0].id;
    const connection = (
      await db.query(
        "SELECT id,binding_generation FROM pms.channel_connections WHERE property_id=$1",
        [propertyId],
      )
    ).rows[0];
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expect(
        persistChannexAssignments(client, {
          propertyId,
          bookingId,
          connectionId: connection.id,
          providerBookingId: input.bookingId,
          revisionId: input.revisionId,
          channel: "booking_com",
          canceled: false,
          rooms: [
            {
              externalRoomTypeId: roomId,
              externalRatePlanId: rateId,
              checkIn: "2026-09-12",
              checkOut: "2026-09-13",
              adults: 2,
              children: 0,
            },
          ],
        }),
      ).rejects.toThrow("operational_mapping_unavailable");
      await client.query("ROLLBACK");
      expect(
        await resolveStagingCatalogReference(client, {
          propertyId,
          bookingId,
          connectionId: connection.id,
          bindingGeneration: randomUUID(),
          providerBookingId: input.bookingId,
          revisionId: input.revisionId,
          externalRoomTypeId: roomId,
          externalRatePlanId: rateId,
        }),
      ).toEqual([]);
    } finally {
      client.release();
    }
    const repair = () =>
      importChannexStagingReservation(
        config(),
        {
          providerPropertyId: input.providerPropertyId,
          channelBookingId: input.bookingId,
          revision: input.revisionId,
          approvalRef: input.approvalRef,
          repairAssignments: true,
        },
        (url, init) => request(url, { ...init, redirect: "error" }),
      );
    await expect(repair()).rejects.toThrow("Canonical inventory coverage is incomplete");
    expect(
      (
        await db.query("SELECT 1 FROM pms.operational_booking_assignments WHERE property_id=$1", [
          propertyId,
        ])
      ).rowCount,
    ).toBe(0);
    const canonicalRate = (
      await db.query(
        "INSERT INTO pms.rate_plans(property_id,room_type_id,code,name,currency) VALUES($1,$2,'later','Later mapping','EUR') RETURNING id",
        [propertyId, canonicalRoomId],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id,status)
       VALUES($1,$2,$3,$4,$5,$6,'disabled')`,
      [propertyId, connection.id, canonicalRoomId, canonicalRate, roomId, rateId],
    );
    await expect(adoptChannexStagingCatalog(config(), input, request)).rejects.toThrow(
      "staging_catalog_replay_conflict",
    );
    await expect(repair()).rejects.toThrow("operational_mapping_unavailable");
    await db.query("DELETE FROM pms.channel_rate_plan_mappings WHERE property_id=$1", [propertyId]);
    await seedChannexAssignmentInventory(db, propertyId, canonicalRoomId);
    await expect(repair()).resolves.toMatchObject({ status: "succeeded", repaired: true });
    const assignments = (
      await db.query(
        "SELECT rate_plan_id,assignment_payload FROM pms.operational_booking_assignments WHERE property_id=$1",
        [propertyId],
      )
    ).rows;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].rate_plan_id).toBeNull();
    expect(assignments[0].assignment_payload.channexStay.externalRatePlanId).toBe(rateId);
    expect(assignments[0].assignment_payload.stagingCatalogReferenceId).toBeTruthy();
    const beforeReplay = await snapshot();
    await expect(repair()).resolves.toMatchObject({ status: "succeeded", repaired: false });
    expect(await snapshot()).toEqual(beforeReplay);
    expect(
      (
        await db.query(
          "SELECT assigned_count FROM pms.inventory_days WHERE property_id=$1 AND stay_date='2026-09-12'",
          [propertyId],
        )
      ).rows[0].assigned_count,
    ).toBe(1);
  });
  it("rejects disabled mappings and terminal closure on adoption replay", async () => {
    const { request } = provider(),
      preview = await adoptChannexStagingCatalog(config(), input, request);
    const applied = await adoptChannexStagingCatalog(
      config(),
      { ...input, applyHash: preview.hash },
      request,
    );
    await db.query(
      "UPDATE pms.channel_room_type_mappings SET status='disabled' WHERE property_id=$1",
      [propertyId],
    );
    await expect(adoptChannexStagingCatalog(config(), input, request)).rejects.toThrow(
      "staging_catalog_replay_conflict",
    );
    await db.query(
      "UPDATE pms.channel_room_type_mappings SET status='active' WHERE property_id=$1",
      [propertyId],
    );
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await db.query(
      `INSERT INTO pms.room_type_closures(property_id,room_type_id,command_id,request_fingerprint,
      expected_room_facts_revision,expected_room_units_revision,previous_calendar_revision,closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
      VALUES($1,$2,gen_random_uuid(),repeat('a',64),1,1,1,2,'2026-09-12',now(),gen_random_uuid())`,
      [propertyId, applied.roomTypeId],
    );
    await db.query("COMMIT");
    await expect(adoptChannexStagingCatalog(config(), input, request)).rejects.toThrow(
      "staging_catalog_replay_conflict",
    );
    await expect(
      db.query(
        "UPDATE pms.channex_staging_catalog_references SET evidence_hash=repeat('b',64) WHERE property_id=$1",
        [propertyId],
      ),
    ).rejects.toThrow("Staging catalog references are immutable");
  });
  it("bounds the initial binding lock wait before any provider read", async () => {
    const locker = new pg.Client({ connectionString: databaseUrl });
    const before = await snapshot();
    let reads = 0;
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM pms.channel_connections WHERE property_id=$1 FOR UPDATE", [
        propertyId,
      ]);
      await expect(
        adoptChannexStagingCatalog(config(), input, async () => {
          reads++;
          throw new Error("Provider must not be read while binding is locked");
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(reads).toBe(0);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    expect(await snapshot()).toEqual(before);
  }, 12000);
  it("rejects a binding-generation change during provider reads", async () => {
    const { request } = provider(),
      before = await snapshot();
    let changed = false;
    const raced: typeof fetch = async (url, init) => {
      const response = await request(url, init);
      if (!changed) {
        changed = true;
        await db.query(
          "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
          [propertyId],
        );
      }
      return response;
    };
    await expect(adoptChannexStagingCatalog(config(), input, raced)).rejects.toThrow(
      "staging_catalog_binding_changed",
    );
    expect(await snapshot()).toEqual(before);
  });
});
