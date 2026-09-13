import { prepareStagingReadiness } from "./channexStagingReadinessTestFixture.js";
import { importChannexStagingReservation } from "../jobs/channexBookings.js";
import {
  seedChannexAssignmentInventory,
  clearChannexAssignmentFixture,
} from "../jobs/channexAssignmentTestFixture.js";
import { persistChannexAssignments } from "./channexBookingAssignments.js";
import { resolveStagingCatalogReference } from "./channexStagingCatalogReference.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      "booking.nightly_revenue_evidence",
      "booking.nightly_revenue_room_scopes",
      "pms.inventory_materialization_coverage",
      "hotel_catalog.property_locations",
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
      "booking.nightly_revenue_evidence",
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
  it("previews breakfast without writes and applies concurrently once, preserving staff edits and jobs", async () => {
    const { data, request } = provider(),
      before = await snapshot();
    data[`rate_plans/${rateId}`].attributes.meal_type = "breakfast";
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
    data[`rate_plans/${rateId}`].attributes.meal_type = "breakfast";
    await expect(
      adoptChannexStagingCatalog(config(), { ...input, applyHash: preview.hash }, request),
    ).rejects.toThrow("staging_catalog_evidence_changed");
    expect(await snapshot()).toEqual(before);
    data[`rate_plans/${rateId}`].attributes.meal_type = "none";
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
  const bootstrapSnapshot = async () => {
    const { jobs: _jobs, ...state } = await snapshot();
    return state;
  };
  async function bootstrap() {
    // Remove the suite's imported-booking seed before exercising first import.
    await db.query("DELETE FROM pms.channel_booking_mappings WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM booking.guest_bookings WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId]);
    const { data } = provider();
    const revision = data[`booking_revisions/${input.revisionId}`].attributes;
    Object.assign(revision, {
      arrival_date: "2026-09-14",
      departure_date: "2026-09-15",
      amount: "100.00",
      ota_reservation_code: "6431849020",
      ota_name: "BookingCom",
    });
    revision.rooms[0].days = { "2026-09-14": "100.00" };
    revision.rooms[0].meta.rate_plan_code = "16385048";
    data[`channels/${input.channelId}`].attributes.rate_plans[0].settings.rate_plan_code =
      "16385048";
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method !== "POST") {
        const path = new URL(String(url)).pathname.replace("/api/v1/", "");
        if (!data[path]) throw new Error("Unexpected provider read");
        return Response.json({ data: data[path] });
      }
      expect(new URL(String(url)).pathname).toBe(
        `/api/v1/booking_revisions/${input.revisionId}/ack`,
      );
      return Response.json({ success: true });
    });
    return {
      data,
      request,
      catalog: (applyHash?: string) =>
        adoptChannexStagingCatalog(config(), { ...input, preImport: true, applyHash }, request),
      ingest: (catalogHash?: string) =>
        importChannexStagingReservation(
          config(),
          {
            providerPropertyId: input.providerPropertyId,
            channelBookingId: input.bookingId,
            revision: input.revisionId,
            approvalRef: "VAY-2013:test",
            ...(catalogHash ? { catalogHash, channelId: input.channelId } : {}),
          },
          request,
        ),
    };
  }
  it("bootstraps concurrently, uses owned unpublished capacity, and imports exact OTA evidence once", async () => {
    const { catalog, ingest, request, data } = await bootstrap();
    expect(await ingest()).toMatchObject({
      status: "dead_lettered",
      failureCode: "operational_mapping_unavailable",
    });
    const oldJob = (
      await db.query("SELECT * FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId])
    ).rows;
    const before = await bootstrapSnapshot(),
      preview = await catalog();
    expect(preview.outcome).toBe("preview");
    expect(await bootstrapSnapshot()).toEqual(before);
    expect((await catalog()).hash).toBe(preview.hash);
    const results = await Promise.all([catalog(preview.hash), catalog(preview.hash)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["adopted", "replayed"]);
    const roomTypeId = results[0].roomTypeId!;
    expect(
      (
        await db.query(
          "SELECT guest_booking_id FROM pms.channex_staging_catalog_references WHERE property_id=$1",
          [propertyId],
        )
      ).rows,
    ).toEqual([{ guest_booking_id: null }]);
    await prepareStagingReadiness(db, databaseUrl!, propertyId, roomTypeId);
    expect(
      (
        await db.query(
          "SELECT total_count,available_count FROM pms.inventory_days WHERE property_id=$1",
          [propertyId],
        )
      ).rows,
    ).toEqual([{ total_count: 1, available_count: 1 }]);
    await Promise.all([ingest(preview.hash), ingest(preview.hash)]);
    expect(await ingest(preview.hash)).toMatchObject({ status: "succeeded" });
    const after = await bootstrapSnapshot();
    expect(
      (
        await db.query(
          "SELECT COALESCE(sum(available_rooms) FILTER (WHERE sellable_publicly),0)::int available FROM distribution.public_room_offer_snapshots WHERE property_id=$1",
          [propertyId],
        )
      ).rows,
    ).toEqual([{ available: 0 }]);
    for (const table of [
      "booking.guest_bookings",
      "pms.channel_booking_mappings",
      "pms.operational_booking_assignments",
      "booking.nightly_revenue_evidence",
      "pms.room_types",
      "pms.channex_staging_catalog_references",
    ])
      expect(after[table]).toHaveLength(1);
    expect(after["booking.nightly_revenue_evidence"]).toMatchObject([
      {
        currency: "GBP",
        gross_room_amount: "100.0000",
        source_kind: "ota",
        evidence_quality: "exact",
      },
    ]);
    expect(after["pms.operational_booking_assignments"]).toMatchObject([
      { rate_plan_id: null, assignment_status: "pending", room_id: null },
    ]);
    expect(after["pms.inventory_days"]).toMatchObject([{ assigned_count: 1, available_count: 0 }]);
    expect(await ingest(preview.hash)).toMatchObject({ status: "succeeded" });
    expect(await bootstrapSnapshot()).toEqual(after);
    expect(
      (await db.query("SELECT * FROM platform.jobs WHERE id=$1", [oldJob[0].id])).rows,
    ).toEqual(oldJob);
    expect(
      (await db.query("SELECT * FROM pms.rate_plans WHERE property_id=$1", [propertyId])).rows,
    ).toEqual([]);
  });
  it("rolls back the import when capacity is absent, retaining only bootstrap and failed job evidence", async () => {
    const { catalog, ingest, request, data } = await bootstrap();
    const preview = await catalog();
    await catalog(preview.hash);
    const before = await bootstrapSnapshot();
    expect(await ingest(preview.hash)).toMatchObject({
      status: "pending",
      failureCode: "operational_inventory_unavailable",
    });
    expect(await bootstrapSnapshot()).toEqual(before);
    expect(
      vi.mocked(request).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });
  it("rejects changed provider/binding facts and refuses normal import reference fallback", async () => {
    const { catalog, ingest, request, data } = await bootstrap();
    const preview = await catalog();
    data[`booking_revisions/${input.revisionId}`].attributes.rooms[0].days["2026-09-14"] = "101.00";
    await expect(catalog(preview.hash)).rejects.toThrow("staging_catalog_evidence_changed");
    data[`booking_revisions/${input.revisionId}`].attributes.rooms[0].days["2026-09-14"] = "100.00";
    await db.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
      [propertyId],
    );
    await expect(catalog(preview.hash)).rejects.toThrow("staging_catalog_evidence_changed");
    const current = await catalog();
    await catalog(current.hash);
    const before = await bootstrapSnapshot();
    expect(await ingest()).toMatchObject({
      status: "dead_lettered",
      failureCode: "operational_mapping_unavailable",
    });
    expect(await bootstrapSnapshot()).toEqual(before);
    await db.query(
      "UPDATE pms.channel_room_type_mappings SET status='disabled' WHERE property_id=$1",
      [propertyId],
    );
    await expect(ingest(current.hash)).rejects.toThrow("staging_catalog_replay_conflict");
  });
  it.each(["exact", "name", "occupancy_limits", "room_attributes"])(
    "reuses only compatible staging room facts: %s",
    async (field) => {
      const { catalog, data, request } = await bootstrap(),
        first = await catalog();
      const adopted = await catalog(first.hash);
      const next = { ...input, bookingId: randomUUID(), revisionId: randomUUID(), preImport: true };
      data[`booking_revisions/${next.revisionId}`] = structuredClone(
        data[`booking_revisions/${input.revisionId}`],
      );
      data[`booking_revisions/${next.revisionId}`].id = next.revisionId;
      data[`booking_revisions/${next.revisionId}`].attributes.booking_id = next.bookingId;
      if (field !== "exact") {
        const changes = {
          name: "Changed",
          occupancy_limits: { total: 3, adults: 3, children: 0 },
          room_attributes: { channexStagingAdoption: { providerRoomCount: 2 } },
        };
        await db.query(`UPDATE pms.room_types SET ${field}=$2 WHERE id=$1`, [
          adopted.roomTypeId,
          changes[field as keyof typeof changes],
        ]);
        const before = await bootstrapSnapshot();
        await expect(adoptChannexStagingCatalog(config(), next, request)).rejects.toThrow(
          "staging_catalog_mapping_conflict",
        );
        expect(await bootstrapSnapshot()).toEqual(before);
        return;
      }
      const preview = await adoptChannexStagingCatalog(config(), next, request);
      expect(
        await adoptChannexStagingCatalog(config(), { ...next, applyHash: preview.hash }, request),
      ).toMatchObject({ outcome: "adopted", roomTypeId: adopted.roomTypeId });
      expect(
        (await db.query("SELECT id FROM pms.room_types WHERE property_id=$1", [propertyId])).rows,
      ).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT id FROM pms.channex_staging_catalog_references WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toHaveLength(2);
    },
  );
  it.each([false, true])(
    "blocks the competing import key while catalog=%s is pending",
    async (catalogFirst) => {
      const { catalog, ingest, request } = await bootstrap(),
        preview = await catalog();
      await catalog(preview.hash);
      const provider = request.getMockImplementation()!;
      let reads = 0;
      request.mockImplementation(async (url, init) => {
        if (String(url).endsWith(input.revisionId) && ++reads === (catalogFirst ? 2 : 1))
          return new Response(null, { status: 503 });
        return provider(url, init);
      });
      expect(await ingest(catalogFirst ? preview.hash : undefined)).toMatchObject({
        status: "pending",
      });
      request.mockImplementation(provider);
      const before = (
        await db.query("SELECT * FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId])
      ).rows;
      await expect(ingest(catalogFirst ? undefined : preview.hash)).rejects.toThrow(
        "staging_original_import_in_progress",
      );
      expect(
        (
          await db.query("SELECT * FROM platform.jobs WHERE payload->>'propertyId'=$1", [
            propertyId,
          ])
        ).rows,
      ).toEqual(before);
    },
  );
  it.each(["revision", "mapping"])(
    "rejects changed %s after receipt verification without partial writes",
    async (change) => {
      const { catalog, data, request } = await bootstrap(),
        preview = await catalog();
      await catalog(preview.hash);
      let before = await bootstrapSnapshot();
      let reads = 0;
      const changed: typeof fetch = async (url, init) => {
        if (String(url).endsWith(input.revisionId) && ++reads === 2) {
          if (change === "revision")
            data[`booking_revisions/${input.revisionId}`].attributes.rooms[0].days["2026-09-14"] =
              "101.00";
          else {
            const rate = (
              await db.query(
                `INSERT INTO pms.rate_plans(property_id,room_type_id,code,name,currency)
            SELECT property_id,room_type_id,'conflict','Conflict','EUR' FROM pms.channex_staging_catalog_references WHERE property_id=$1 RETURNING id`,
                [propertyId],
              )
            ).rows[0];
            await db.query(
              `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id)
            SELECT property_id,connection_id,room_type_id,$2,external_room_type_id,external_rate_plan_id FROM pms.channex_staging_catalog_references WHERE property_id=$1`,
              [propertyId, rate.id],
            );
            before = await bootstrapSnapshot();
          }
        }
        return request(url, init);
      };
      expect(
        await importChannexStagingReservation(
          config(),
          {
            providerPropertyId: input.providerPropertyId,
            channelBookingId: input.bookingId,
            revision: input.revisionId,
            approvalRef: "VAY-2013:test",
            catalogHash: preview.hash,
            channelId: input.channelId,
          },
          changed,
        ),
      ).toMatchObject({
        status: "dead_lettered",
        failureCode:
          change === "revision"
            ? "staging_catalog_revision_changed"
            : "operational_mapping_unavailable",
      });
      expect(await bootstrapSnapshot()).toEqual(before);
    },
  );
  it("rolls back assignments, occupancy and booking when nightly evidence persistence fails", async () => {
    const { catalog, ingest } = await bootstrap(),
      preview = await catalog(),
      adopted = await catalog(preview.hash);
    await prepareStagingReadiness(db, databaseUrl!, propertyId, adopted.roomTypeId!);
    const before = await bootstrapSnapshot();
    await db.query(`CREATE FUNCTION pms.vay2013_reject_revenue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.property_id='${propertyId}'::uuid THEN RAISE EXCEPTION 'synthetic revenue failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER vay2013_reject_revenue BEFORE INSERT ON booking.nightly_revenue_evidence FOR EACH ROW EXECUTE FUNCTION pms.vay2013_reject_revenue()`);
    try {
      expect(await ingest(preview.hash)).toMatchObject({
        status: "pending",
        failureCode: "write_unavailable",
      });
      expect(await bootstrapSnapshot()).toEqual(before);
    } finally {
      await db.query(
        "DROP TRIGGER vay2013_reject_revenue ON booking.nightly_revenue_evidence; DROP FUNCTION pms.vay2013_reject_revenue()",
      );
    }
  });
});
