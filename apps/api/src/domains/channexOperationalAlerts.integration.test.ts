import {
  clearChannexAssignmentFixture,
  seedChannexAssignmentFixture,
} from "../jobs/channexAssignmentTestFixture.js";
import { createPgChannexManagementPlanPort } from "../integrations/channexManagementPlans.js";
import { createChannexManagementProvider } from "../integrations/channexManagement.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import pg from "pg";
import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { registerProviderWebhookRoutes } from "../routes/providerWebhooks.js";
import { createPgProviderWebhookStore } from "../platform/providerWebhooks.js";
import { createPgPmsChannexManagementCommandPort } from "./pmsChannexManagementCommandStore.js";
import { listChannexAlerts } from "./channexOperationalAlerts.js";
import { runChannexBookingJobs } from "../jobs/channexBookings.js";
import type { RequestContext } from "@vayada/backend-auth";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
const P = "84600000-0000-4000-8000-000000000001",
  U = "84600000-0000-4000-8000-000000000002",
  OTHER = "84600000-0000-4000-8000-000000000003";
describe.skipIf(!url)("operational alert receipt and canonical recovery", () => {
  const db = new pg.Pool({ connectionString: url });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    reply.code(500).send({ error: String(error) });
  });
  const commands = createPgPmsChannexManagementCommandPort({
    connectionString: url ?? "postgresql://disabled",
  });
  const context = {
    actor: { internalUserId: U },
    audit: { requestId: "vay846", correlationId: "vay846" },
  } as RequestContext;
  beforeAll(async () => {
    await db.query("BEGIN; SET LOCAL session_replication_role=replica");
    await clearChannexAssignmentFixture(db, P);
    await db.query("COMMIT");
    await db.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM pms.channel_operational_alert_occurrences WHERE alert_id IN (SELECT id FROM pms.channel_operational_alerts WHERE property_id='${P}');
      DELETE FROM pms.channel_operational_alerts WHERE property_id='${P}';
      DELETE FROM platform.idempotency_keys WHERE response_resource_id IN(SELECT id::text FROM platform.external_webhook_events WHERE raw_payload->>'property_id' IN('provider-846','unowned-846')) OR property_id='${P}';
      DELETE FROM platform.external_webhook_events WHERE raw_payload->>'property_id' IN('provider-846','unowned-846');
      DELETE FROM platform.product_audit_events WHERE property_id='${P}' OR correlation_id='vay846';
      DELETE FROM platform.job_attempts WHERE job_id IN(SELECT id FROM platform.jobs WHERE correlation_id='vay846');
      DELETE FROM platform.dead_letter_events WHERE correlation_id='vay846';
      DELETE FROM platform.jobs WHERE correlation_id='vay846' OR payload->'rawPayload'->>'property_id' IN('provider-846','unowned-846');
      DELETE FROM platform.domain_events WHERE payload->'rawPayload'->>'property_id' IN('provider-846','unowned-846');
      DELETE FROM pms.channel_booking_mappings WHERE property_id='${P}';
      DELETE FROM booking.booking_guests WHERE guest_booking_id IN(SELECT id FROM booking.guest_bookings WHERE property_id='${P}');
      DELETE FROM booking.guest_bookings WHERE property_id='${P}';
      DELETE FROM pms.channel_connections WHERE property_id='${P}'; DELETE FROM pms.channel_binding_claims WHERE property_id='${P}';
      DELETE FROM hotel_catalog.properties WHERE id='${P}'; DELETE FROM identity.users WHERE id='${U}'; COMMIT`);

    await db.query(
      "INSERT INTO identity.users(id,email,name) VALUES($1,'vay846@example.test','Alert tester')",
      [U],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay846','Alert test')",
      [P],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex','provider-846','active','repair')",
      [P],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1,'channex','provider-846','connected')",
      [P],
    );
    await seedChannexAssignmentFixture(db, P);
    await app.register(registerProviderWebhookRoutes, {
      store: createPgProviderWebhookStore({ connectionString: url! }),
      secrets: { channex: "synthetic" },
      modes: { channex: "mutating" },
    });
  });
  afterAll(async () => {
    await app.close();
    await commands.close?.();
    await db.end();
  });
  const deliver = (
    event: string,
    payload: Record<string, unknown> = {},
    timestamp = "2026-09-06T00:00:00Z",
    property_id = "provider-846",
  ) =>
    app.inject({
      method: "POST",
      url: "/webhooks/channex",
      headers: { "content-type": "application/json", "x-vayada-webhook-token": "synthetic" },
      payload: JSON.stringify({ event, payload, property_id, timestamp }),
    });
  it("keeps duplicate/unknown intake non-mutating, scoped and free of guest details", async () => {
    for (const event of [
      "booking_unmapped_room",
      "booking_unmapped_rate",
      "non_acked_booking",
      "sync_error",
      "sync_warning",
      "rate_error",
      "disconnected_channel",
    ]) {
      expect(
        (
          await deliver(event, {
            booking_id: `booking-${event}`,
            booking_revision_id: `rev-${event}`,
            customer_name: "Private Guest",
            channel_id: "channel-846",
          })
        ).json(),
      ).not.toHaveProperty("error");
    }
    await deliver("sync_error", {
      booking_id: "booking-sync_error",
      booking_revision_id: "rev-sync_error",
      customer_name: "Private Guest",
      channel_id: "channel-846",
    });
    await deliver(
      "sync_error",
      {
        booking_id: "booking-sync_error",
        booking_revision_id: "rev-sync_error",
        channel_id: "channel-846",
      },
      "2026-09-05T00:00:00Z",
    );
    await deliver("unknown", { customer_name: "Private Guest" });
    await deliver("sync_error", {}, undefined, "unowned-846");
    const alerts = await listChannexAlerts(db, P);
    expect(alerts).toHaveLength(7);
    expect(JSON.stringify(alerts)).not.toContain("Private Guest");
    expect(alerts.find((a) => a.eventType === "sync_error")).toMatchObject({ occurrences: 2 });
    expect(await listChannexAlerts(db, OTHER)).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE payload->'rawPayload'->>'property_id'='provider-846'",
        )
      ).rows[0].n,
    ).toBe(1); // unknown fallback review only
    expect(
      (
        await db.query("SELECT count(*)::int n FROM booking.guest_bookings WHERE property_id=$1", [
          P,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
  it("checks durable persistence before acknowledgement and never duplicates a reservation", async () => {
    const alert = (await listChannexAlerts(db, P)).find(
      (a) => a.eventType === "non_acked_booking",
    )!;
    expect(await commands.recoverAlert!(context, OTHER, alert.id, 0)).toEqual({
      ok: false,
      code: "alert_not_actionable",
    });
    await Promise.all([
      commands.recoverAlert!(context, P, alert.id, 0),
      commands.recoverAlert!(context, P, alert.id, 0),
    ]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE payload->>'recoveryAlertId'=$1",
          [alert.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const revision = {
      id: "rev-non_acked_booking",
      attributes: {
        property_id: "provider-846",
        booking_id: "booking-non_acked_booking",
        status: "new",
        arrival_date: "2026-09-10",
        departure_date: "2026-09-12",
        amount: "200.00",
        currency: "EUR",
        inserted_at: "2026-09-06T01:00:00Z",
        rooms: [
          {
            room_type_id: "provider-room",
            rate_plan_id: "provider-rate",
            occupancy: { adults: 1, children: 0 },
          },
        ],
      },
    };
    let ackCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === "POST") {
        expect(
          (
            await db.query(
              "SELECT count(*)::int n FROM booking.guest_bookings WHERE property_id=$1",
              [P],
            )
          ).rows[0].n,
        ).toBe(1);
        ackCalls++;
        if (ackCalls === 1) throw new Error("lost ack response");
        return new Response(null, { status: 204 });
      }
      return Response.json({ data: String(input).includes("/feed") ? [revision] : revision });
    };
    const run = () =>
      runChannexBookingJobs(url!, {
        apiBaseUrl: "https://app.channex.io",
        apiKey: "synthetic",
        ownsMutation: () => true,
        fetch: fetcher,
        limit: 1,
      });
    expect((await run()).retryScheduled).toBe(1);
    expect((await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt).toBeNull();
    await db.query(
      "UPDATE platform.jobs SET run_after=now() WHERE payload->>'recoveryAlertId'=$1",
      [alert.id],
    );
    expect((await run()).succeeded).toBe(1);
    expect(ackCalls).toBe(2);
    expect(
      (await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt,
    ).not.toBeNull();
    expect(
      (
        await db.query("SELECT count(*)::int n FROM booking.guest_bookings WHERE property_id=$1", [
          P,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
  it("queues both reconnection jobs once and waits for durable ingestion and ARI evidence", async () => {
    const alert = (await listChannexAlerts(db, P)).find(
      (a) => a.eventType === "disconnected_channel",
    )!;
    await Promise.all(
      Array.from({ length: 8 }, () => commands.recoverAlert!(context, P, alert.id, 0)),
    );
    const rows = (
      await db.query(
        `SELECT id::text AS "jobId",property_id::text AS "propertyId",correlation_id AS "correlationId",1 AS "attemptNumber",5 AS "maxAttempts",payload AS input FROM platform.jobs WHERE payload->>'recoveryAlertId'=$1 ORDER BY job_type`,
        [alert.id],
      )
    ).rows as ChannexManagementJob[];
    expect(rows).toHaveLength(2);
    const bookingJob = rows.find((row) => row.input.operationType === "sync_bookings")!;
    let active = false,
      handedOff = false;
    const plans = createPgChannexManagementPlanPort({
      connectionString: url!,
      bookingRevisionHandoff: async () => {
        handedOff = true;
      },
    });
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://app.channex.io",
      apiKey: "synthetic",
      plans,
      fetch: async (input) =>
        Response.json({
          data: String(input).includes("/channels/")
            ? { is_active: active, properties: ["provider-846"] }
            : [{ id: "disconnected-revision" }],
        }),
    });
    expect(await provider.execute(bookingJob)).toMatchObject({ ok: false, code: "invalid_state" });
    expect(handedOff).toBe(false);
    active = true;
    expect(await provider.execute(bookingJob)).toMatchObject({
      ok: false,
      code: "provider_unavailable",
      message: expect.stringContaining("Booking revisions are still processing"),
    });
    expect(handedOff).toBe(true);
    expect((await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt).toBeNull();
    await db.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,status,tenant_scope,resource_product,resource_type,resource_id,payload,correlation_id,finished_at)
      VALUES('vay846-disconnect-child','pms.channex.webhooks','channex.ingest-booking','succeeded','external','pms','channel_booking','disconnect-booking',$1::jsonb,'vay846',now())`,
      [
        JSON.stringify({
          propertyId: P,
          providerPropertyId: "provider-846",
          revision: "disconnected-revision",
        }),
      ],
    );
    expect(await provider.execute(bookingJob)).toMatchObject({
      ok: true,
      alertRecoveryVerified: true,
    });
    await db.query(
      `UPDATE platform.jobs SET status='succeeded',finished_at=now(),job_metadata=job_metadata||'{"alertRecoveryVerified":true}'::jsonb WHERE id=$1`,
      [bookingJob.jobId],
    );
    expect((await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt).toBeNull();
    await db.query(
      `UPDATE platform.jobs SET status='succeeded',finished_at=now(),job_metadata=job_metadata||'{"alertRecoveryVerified":true}'::jsonb WHERE id=$1`,
      [rows.find((row) => row.input.operationType === "sync_ari")!.jobId],
    );
    expect(
      (await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt,
    ).not.toBeNull();
    await plans.close();
  });

  it("retains late events with the resolved incident and opens a later recurrence", async () => {
    const original = (await listChannexAlerts(db, P)).find(
      (a) => a.eventType === "non_acked_booking",
    )!;
    const payload = {
      booking_id: "booking-non_acked_booking",
      booking_revision_id: "rev-non_acked_booking",
      channel_id: "channel-846",
    };
    await deliver("non_acked_booking", payload, "2026-09-05T00:00:00Z");
    expect(
      (await listChannexAlerts(db, P)).filter((a) => a.eventType === "non_acked_booking"),
    ).toHaveLength(1);
    await db.query(
      "UPDATE pms.channel_operational_alerts SET resolved_at='2026-09-06T12:00:00Z' WHERE id=$1",
      [original.id],
    );
    await deliver("non_acked_booking", payload, "2026-09-06T13:00:00Z");
    const alerts = (await listChannexAlerts(db, P)).filter(
      (a) => a.eventType === "non_acked_booking",
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.find((a) => a.id !== original.id)?.resolvedAt).toBeNull();
  });
  it("rejects unmapped authoritative revisions, then imports exactly once after correction", async () => {
    const alert = (await listChannexAlerts(db, P)).find(
      (a) => a.eventType === "booking_unmapped_room",
    )!;
    await commands.recoverAlert!(context, P, alert.id, 0);
    let corrected = false,
      acks = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        acks++;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        data: [
          {
            id: "rev-booking_unmapped_room",
            attributes: {
              property_id: "provider-846",
              booking_id: "booking-booking_unmapped_room",
              status: "new",
              arrival_date: "2026-09-10",
              departure_date: "2026-09-12",
              amount: "200.00",
              currency: "EUR",
              inserted_at: "2026-09-06T01:00:00Z",
              rooms: [
                {
                  ...(corrected
                    ? { room_type_id: "provider-room", rate_plan_id: "provider-rate" }
                    : {}),
                  occupancy: { adults: 1, children: 0 },
                },
              ],
            },
          },
        ],
      });
    };
    const run = () =>
      runChannexBookingJobs(url!, {
        apiBaseUrl: "https://app.channex.io",
        apiKey: "synthetic",
        ownsMutation: () => true,
        fetch: fetcher,
        limit: 1,
      });
    expect((await run()).deadLettered).toBe(1);
    expect(acks).toBe(0);
    corrected = true;
    await commands.recoverAlert!(context, P, alert.id, 1);
    expect((await run()).succeeded).toBe(1);
    expect(acks).toBe(1);
    expect(
      (await listChannexAlerts(db, P)).find((a) => a.id === alert.id)?.resolvedAt,
    ).not.toBeNull();
  });
});
