import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { importChannexStagingReservation, runChannexBookingJobs } from "./channexBookings.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(databaseUrl).pathname))
  throw new Error("Refusing non-test database");
const propertyId = "15350000-0000-4000-8000-000000000001";
const providerPropertyId = "15350000-0000-4000-8000-000000000002";
const config = () => ({
  ...loadConfig({
    PMS_OPERATIONS_SOURCE: "target",
    API_BACKGROUND_WORKERS_ENABLED: "false",
    TARGET_DATABASE_URL: databaseUrl ?? "postgresql://localhost/test",
    CHANNEX_API_BASE_URL: "https://staging.channex.io",
    CHANNEX_API_KEY: "test-key",
    PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: propertyId,
    PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
  }),
  apiRuntime: "next" as const,
});
const input = () => ({
  providerPropertyId,
  channelBookingId: randomUUID(),
  revision: randomUUID(),
  approvalRef: "VAY-1535:test",
});

it("rejects unsafe runtime and unbounded identifiers before any I/O", async () => {
  const request = vi.fn();
  for (const change of [
    { backgroundWorkersEnabled: true },
    { apiRuntime: "legacy" as const },
    { channexManagement: { ...config().channexManagement, apiBaseUrl: "https://app.channex.io" } },
    {
      channexManagement: {
        ...config().channexManagement,
        capabilityModes: {
          ...config().channexManagement.capabilityModes,
          bookingSync: "mutating" as const,
        },
      },
    },
  ])
    await expect(
      importChannexStagingReservation({ ...config(), ...change }, input(), request),
    ).rejects.toThrow("invalid_staging_import_scope");
  await expect(
    importChannexStagingReservation(config(), { ...input(), revision: "unknown" }, request),
  ).rejects.toThrow("invalid_staging_import_scope");
  expect(request).not.toHaveBeenCalled();
});

describe.skipIf(!databaseUrl)("scoped staging importer (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  beforeAll(async () => {
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay1535-import','Import test')",
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
  });
  afterAll(async () => {
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
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

  it("imports exactly one revision, ACKs after persist, and leaves unrelated jobs untouched", async () => {
    const selected = input();
    const unrelated = (
      await db.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,payload,priority)
      VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking','unrelated',$2,100) RETURNING id`,
        [randomUUID(), { propertyId }],
      )
    ).rows[0].id;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        expect(String(url)).toBe(
          `https://staging.channex.io/api/v1/booking_revisions/${selected.revision}/ack`,
        );
        expect(
          (
            await db.query(
              "SELECT 1 FROM pms.channel_booking_mappings WHERE property_id=$1 AND external_booking_id=$2",
              [propertyId, selected.channelBookingId],
            )
          ).rowCount,
        ).toBe(1);
        return new Response(null, { status: 204 });
      }
      expect(String(url)).toBe(
        `https://staging.channex.io/api/v1/booking_revisions/${selected.revision}`,
      );
      return Response.json({ data: revision(selected) });
    });
    const first = await importChannexStagingReservation(config(), selected, request);
    expect(first).toMatchObject({ status: "succeeded", attempts: 1, succeeded: 1 });
    expect(await importChannexStagingReservation(config(), selected, request)).toMatchObject({
      jobId: first.jobId,
      status: "succeeded",
      attempts: 1,
      succeeded: 0,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      (await db.query("SELECT status,attempts_count FROM platform.jobs WHERE id=$1", [unrelated]))
        .rows[0],
    ).toEqual({ status: "pending", attempts_count: 0 });
    await db.query("DELETE FROM platform.jobs WHERE id=$1", [unrelated]);
  });

  it("rejects mismatched provider identity and binding changes without ACK or booking writes", async () => {
    for (const variant of ["property", "booking", "revision", "source", "binding"] as const) {
      const selected = input();
      const request = vi.fn<typeof fetch>(async () => {
        const value = revision(selected);
        if (variant === "property") value.attributes.property_id = randomUUID();
        if (variant === "booking") value.attributes.booking_id = randomUUID();
        if (variant === "revision") value.id = randomUUID();
        if (variant === "source") value.attributes.ota_name = "Expedia";
        if (variant === "binding")
          await db.query(
            "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
            [propertyId],
          );
        return Response.json({ data: value });
      });
      expect(await importChannexStagingReservation(config(), selected, request)).toMatchObject({
        status: "dead_lettered",
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.query(
            "SELECT 1 FROM pms.channel_booking_mappings WHERE property_id=$1 AND external_booking_id=$2",
            [propertyId, selected.channelBookingId],
          )
        ).rowCount,
      ).toBe(0);
    }
  });

  it("replays a durable revision after an ambiguous ACK without duplicating the booking", async () => {
    const selected = input();
    let acknowledgements = 0;
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "POST") return Response.json({ data: revision(selected) });
      acknowledgements += 1;
      if (acknowledgements === 1) throw new Error("ACK response lost");
      return new Response(null, { status: 404 });
    });
    const first = await importChannexStagingReservation(config(), selected, request);
    expect(first).toMatchObject({ status: "pending", retryScheduled: 1 });
    await db.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [first.jobId]);
    expect(await importChannexStagingReservation(config(), selected, request)).toMatchObject({
      jobId: first.jobId,
      status: "succeeded",
      attempts: 2,
    });
    expect(acknowledgements).toBe(2);
    expect(
      (
        await db.query(
          "SELECT count(*)::int count FROM booking.guest_bookings WHERE property_id=$1 AND source_booking_id=$2",
          [propertyId, `channex:${propertyId}:${selected.channelBookingId}`],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("reuses retry state and prevents ordinary workers from taking scoped jobs", async () => {
    const selected = input();
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const first = await importChannexStagingReservation(config(), selected, request);
    expect(first).toMatchObject({ status: "pending", attempts: 1, retryScheduled: 1 });
    await db.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [first.jobId]);
    expect(
      await runChannexBookingJobs(databaseUrl!, {
        apiBaseUrl: "https://staging.channex.io",
        apiKey: "test",
        ownsMutation: () => true,
        fetch: request,
      }),
    ).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await importChannexStagingReservation(config(), selected, request)).toMatchObject({
      jobId: first.jobId,
      attempts: 2,
      retryScheduled: 1,
    });
    await db.query(
      "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
      [propertyId],
    );
    await expect(importChannexStagingReservation(config(), input(), request)).rejects.toThrow(
      "staging_binding_changed",
    );
  });
});

function revision(selected: ReturnType<typeof input>) {
  return {
    id: selected.revision,
    attributes: {
      property_id: providerPropertyId,
      booking_id: selected.channelBookingId,
      status: "new",
      ota_name: "BookingCom",
      arrival_date: "2026-09-11",
      departure_date: "2026-09-12",
      amount: "100.00",
      currency: "GBP",
      inserted_at: "2026-09-11T10:00:00Z",
      rooms: [{ occupancy: { adults: 1, children: 0 } }],
    },
  };
}
