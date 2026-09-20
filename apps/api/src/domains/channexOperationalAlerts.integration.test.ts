import { getChannexAlertDiagnostics } from "./channexAlertDiagnostics.js";
import {
  clearChannexAssignmentFixture,
  seedChannexAssignmentFixture,
} from "../jobs/channexAssignmentTestFixture.js";
import { createPgChannexManagementPlanPort } from "../integrations/channexManagementPlans.js";
import {
  channexRequests,
  createChannexManagementProvider,
} from "../integrations/channexManagement.js";
import {
  runPmsChannexManagementWorkerOnce,
  type ChannexManagementJob,
} from "../jobs/pmsChannexManagementWorker.js";
import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { createPmsChannexManagementTargetState } from "../jobs/pmsChannexManagementTargetState.js";
import pg from "pg";
import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  promotePulledChannexBookingRevision,
  registerProviderWebhookRoutes,
} from "../routes/providerWebhooks.js";
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
  it("projects only scoped current-round diagnostics without reconciling resolution or exposing payloads", async () => {
    const client = await db.connect();
    await client.query("BEGIN");
    try {
      const {
        rows: [alert],
      } = await client.query(
        "SELECT * FROM pms.channel_operational_alerts WHERE property_id=$1 AND event_type='disconnected_channel' LIMIT 1",
        [P],
      );
      await client.query("UPDATE pms.channel_operational_alerts SET resolved_at=NULL WHERE id=$1", [
        alert.id,
      ]);
      const read = () => getChannexAlertDiagnostics(client, P, alert.id);
      const {
        rows: [booking],
      } = await client.query(
        "SELECT id FROM pms.channel_operational_alerts WHERE property_id=$1 AND event_type='non_acked_booking' AND cardinality(recovery_jobs)>0 LIMIT 1",
        [P],
      );
      const bookingEvidence = (await getChannexAlertDiagnostics(client, P, booking.id))!;
      expect(bookingEvidence.recovery).toHaveLength(1);
      expect(bookingEvidence.recovery[0]).toMatchObject({
        operation: "booking_import",
        status: "succeeded",
        failure: null,
      });
      for (const patch of [
        { propertyId: OTHER },
        { providerPropertyId: "wrong-property" },
        { bindingGeneration: OTHER },
      ]) {
        await client.query("SAVEPOINT wrong_job");
        await client.query("UPDATE platform.jobs SET payload=payload||$2::jsonb WHERE id=$1", [
          bookingEvidence.recovery[0]!.jobId,
          JSON.stringify(patch),
        ]);
        expect((await getChannexAlertDiagnostics(client, P, booking.id))!.recovery).toEqual([]);
        await client.query("ROLLBACK TO SAVEPOINT wrong_job");
      }
      const {
        rows: [rate],
      } = await client.query(
        "SELECT id FROM pms.channel_operational_alerts WHERE property_id=$1 AND event_type='rate_error' LIMIT 1",
        [P],
      );
      expect(await getChannexAlertDiagnostics(client, P, rate.id)).toMatchObject({
        linkedJobCount: 0,
        recovery: [],
        latestReceipt: { receiptId: expect.any(String) },
      });
      const initial = (await read())!;
      expect(initial.latestReceipt?.receiptId).toBeTruthy();
      expect(initial.recovery).toHaveLength(2);
      expect(initial.linkedJobCount).toBe(2);
      expect(initial.recovery.every((j) => j.status === "succeeded")).toBe(true);
      // Existing verified jobs would resolve this incident through listChannexAlerts; diagnostics must not.
      expect(
        (
          await client.query("SELECT resolved_at FROM pms.channel_operational_alerts WHERE id=$1", [
            alert.id,
          ])
        ).rows[0].resolved_at,
      ).toBeNull();
      expect(await getChannexAlertDiagnostics(client, OTHER, alert.id)).toBeNull();
      expect(await getChannexAlertDiagnostics(client, P, OTHER)).toBeNull();
      const job = initial.recovery[0]!;
      await client.query(
        "UPDATE platform.jobs SET status='dead_lettered',job_metadata=job_metadata||$2::jsonb WHERE id=$1",
        [
          job.jobId,
          JSON.stringify({
            lastErrorCode: "mapping_missing",
            lastErrorMessage: "secret guest@example.test",
            providerRequestId: "secret-token",
          }),
        ],
      );
      expect((await read())!.recovery.find((j) => j.jobId === job.jobId)?.failure).toBe(
        "A required room or rate mapping is missing.",
      );
      await client.query(
        "UPDATE platform.jobs SET job_metadata=job_metadata||$2::jsonb WHERE id=$1",
        [job.jobId, JSON.stringify({ lastErrorCode: "secret guest@example.test" })],
      );
      expect(JSON.stringify(await read())).not.toMatch(
        /secret|guest@example|providerRequestId|alertRecoveryVerified|failureCode/,
      );
      await client.query(
        "UPDATE platform.jobs SET status='running',locked_at=now(),locked_by='diagnostics-test',finished_at=NULL WHERE id=$1",
        [job.jobId],
      );
      expect((await read())!.recovery.find((j) => j.jobId === job.jobId)?.failure).toBeNull();
      await client.query(
        `UPDATE platform.jobs SET payload=jsonb_set(payload,'{recoveryAlertId}','"wrong-alert"') WHERE id=$1`,
        [job.jobId],
      );
      expect((await read())!.recovery).toHaveLength(1);
      await client.query(
        "UPDATE pms.channel_operational_alerts SET recovery_round=recovery_round+1,last_occurred_at=now()+interval '1 hour' WHERE id=$1",
        [alert.id],
      );
      expect(await read()).toMatchObject({
        recovery: [],
        linkedJobCount: 2,
        newerOccurrence: true,
      });
      await client.query(
        "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE id=$1",
        [alert.connection_id],
      );
      expect(await read()).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
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
  it("runs reconnection workers through durable ingestion and failed ARI readback before resolution", async () => {
    await deliver(
      "disconnected_channel",
      { channel_id: "reconnected-846" },
      "2026-09-07T00:00:00Z",
    );
    const alert = (await listChannexAlerts(db, P)).find(
      (a) => a.impact.channelId === "reconnected-846",
    )!;
    const revision = {
      id: "worker-reconnect-revision",
      attributes: {
        property_id: "provider-846",
        booking_id: "worker-reconnect-booking",
        status: "new",
        arrival_date: "2026-09-10",
        departure_date: "2026-09-12",
        amount: "200.00",
        currency: "EUR",
        inserted_at: "2026-09-07T00:00:00Z",
        rooms: [
          {
            room_type_id: "provider-room",
            rate_plan_id: "provider-rate",
            occupancy: { adults: 1, children: 0 },
          },
        ],
      },
    };
    const receipts = createPgProviderWebhookStore({ connectionString: url! });
    const plans = createPgChannexManagementPlanPort({
      connectionString: url!,
      bookingRevisionHandoff: async ({ propertyId, providerPropertyId, revisions }) => {
        for (const revision of revisions)
          await promotePulledChannexBookingRevision({
            store: receipts,
            propertyId,
            providerPropertyId,
            revision: revision as Record<string, unknown>,
          });
      },
    });
    const store = createPgPmsChannexManagementWorkerStore({
      connectionString: url!,
      targetState: createPmsChannexManagementTargetState(),
    });
    let active = false,
      readbackMatches = false,
      acked = false,
      ariWrites = 0;
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      // Deterministic ARI plan isolates the queue/provider/completion contract from catalog setup.
      plans: {
        plan: async (job) =>
          job.input.operationType === "sync_bookings"
            ? plans.plan(job)
            : {
                externalPropertyId: "provider-846",
                verifyRecovery: true,
                recoveryChannelId: "reconnected-846",
                requests: [
                  channexRequests.availability([
                    {
                      property_id: "provider-846",
                      room_type_id: "provider-room",
                      date_from: "2026-09-10",
                      date_to: "2026-09-10",
                      availability: 0,
                    },
                  ]),
                ],
              },
      },
      fetch: async (input, init) => {
        if (String(input).includes("/channels/"))
          return Response.json({ data: { is_active: active, properties: ["provider-846"] } });
        if (String(input).includes("/booking_revisions/"))
          return Response.json({ data: acked ? [] : [revision] });
        if (init?.method === "POST") {
          ariWrites++;
          return Response.json({ meta: { warnings: [] } });
        }
        return Response.json({
          data: { "provider-room": { "2026-09-10": readbackMatches ? 0 : 1 } },
        });
      },
    });
    const run = () =>
      runPmsChannexManagementWorkerOnce({ store, provider, workerId: "vay846-proof" });
    const current = async () => (await listChannexAlerts(db, P)).find((a) => a.id === alert.id)!;
    // Advance only this incident's retry clock and run booking before ARI so that
    // the intermediate unresolved assertion does not depend on tied queue timestamps.
    // Completion and verification are always written by the real workers.
    const due = () =>
      db.query(
        "UPDATE platform.jobs SET run_after=now(),priority=CASE WHEN payload->>'operationType'='sync_bookings' THEN 100001 ELSE 100000 END WHERE payload->>'recoveryAlertId'=$1 AND status='pending'",
        [alert.id],
      );
    try {
      expect(await commands.recoverAlert!(context, P, alert.id, 0)).toMatchObject({ ok: true });
      await due();
      expect((await run()).outcome).toBe("dead_lettered");
      expect((await run()).outcome).toBe("dead_lettered");
      expect(ariWrites).toBe(0);
      expect((await current()).resolvedAt).toBeNull();
      active = true;
      await Promise.all([
        commands.recoverAlert!(context, P, alert.id, 1),
        commands.recoverAlert!(context, P, alert.id, 1),
      ]);
      await due();
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM platform.jobs WHERE payload->>'recoveryAlertId'=$1",
            [alert.id],
          )
        ).rows[0].n,
      ).toBe(4);
      expect((await run()).outcome).toBe("retry_scheduled");
      expect((await run()).outcome).toBe("retry_scheduled");
      expect((await current()).resolvedAt).toBeNull();
      expect(
        await runChannexBookingJobs(url!, {
          apiBaseUrl: "https://staging.channex.io",
          apiKey: "synthetic",
          ownsMutation: () => true,
          limit: 1,
          fetch: async (_input, init) => {
            expect(init?.method).toBe("POST");
            expect(
              (
                await db.query(
                  "SELECT count(*)::int n FROM pms.channel_booking_mappings WHERE property_id=$1 AND external_revision_id=$2",
                  [P, revision.id],
                )
              ).rows[0].n,
            ).toBe(1);
            acked = true;
            return new Response(null, { status: 204 });
          },
        }),
      ).toMatchObject({ succeeded: 1 });
      await due();
      expect(await run()).toMatchObject({ outcome: "succeeded", operationType: "sync_bookings" });
      expect((await current()).resolvedAt).toBeNull();
      readbackMatches = true;
      expect(await run()).toMatchObject({ outcome: "succeeded", operationType: "sync_ari" });
      const done = await current();
      expect(done.resolvedAt).not.toBeNull();
      expect(done.recovery).toHaveLength(2);
      expect(done.recovery.every((job) => job.status === "succeeded" && job.verified)).toBe(true);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM pms.channel_booking_mappings WHERE property_id=$1 AND external_revision_id=$2",
            [P, revision.id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await store.close?.();
      await plans.close();
      await receipts.close?.();
    }
  });
});
