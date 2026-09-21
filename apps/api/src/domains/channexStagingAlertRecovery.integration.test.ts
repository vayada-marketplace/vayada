import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import { loadConfig } from "../config.js";
import { stagingAlertRecovery } from "./channexStagingAlertRecovery.js";
import { createPgPmsChannexManagementCommandPort } from "./pmsChannexManagementCommandStore.js";
import { listChannexAlerts } from "./channexOperationalAlerts.js";
import { importChannexStagingReservation, runChannexBookingJobs } from "../jobs/channexBookings.js";
import {
  seedChannexAssignmentFixture,
  clearChannexAssignmentFixture,
} from "../jobs/channexAssignmentTestFixture.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
const targetDatabaseUrl = url ?? "postgresql://api_test@localhost/test";
const managementDatabaseUrl = new URL(targetDatabaseUrl);
managementDatabaseUrl.username = "channex_test_worker";
const propertyId = "84610000-0000-4000-8000-000000000001",
  providerPropertyId = "84610000-0000-4000-8000-000000000002",
  userId = "84610000-0000-4000-8000-000000000003";
const config = () => ({
  ...loadConfig({
    API_BACKGROUND_WORKERS_ENABLED: "false",
    PMS_OPERATIONS_SOURCE: "target",
    TARGET_DATABASE_URL: targetDatabaseUrl,
    PMS_CHANNEX_MANAGEMENT_DATABASE_URL: managementDatabaseUrl.toString(),
    CHANNEX_API_BASE_URL: "https://staging.channex.io",
    CHANNEX_API_KEY: "synthetic",
    PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
    PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID: propertyId,
  }),
  apiRuntime: "next" as const,
});
it("rejects non-staging authority and invalid identity before I/O", async () => {
  const input = {
    alertId: randomUUID(),
    providerPropertyId,
    channelBookingId: randomUUID(),
    revision: randomUUID(),
    canonicalBookingId: randomUUID(),
    approvalRef: "VAY-846:test",
  };
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
    await expect(stagingAlertRecovery({ ...config(), ...change }, input)).rejects.toThrow(
      "invalid_staging_alert_scope",
    );
  await expect(stagingAlertRecovery(config(), { ...input, revision: "unknown" })).rejects.toThrow(
    "invalid_staging_alert_scope",
  );
});

describe.skipIf(!url)("approved exact staging alert recovery", () => {
  const db = new pg.Pool({ connectionString: url });
  const commands = createPgPmsChannexManagementCommandPort({
    connectionString: url ?? "disabled",
    stagingAlertPropertyId: propertyId,
  });
  const context = {
    actor: { internalUserId: userId },
    audit: { requestId: "VAY-846:test" },
  } as RequestContext;
  beforeAll(async () => {
    await db.query(
      "INSERT INTO identity.users(id,email,name) VALUES($1,'vay846-scope@example.test','Synthetic')",
      [userId],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay846-scope','Synthetic')",
      [propertyId],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [propertyId, providerPropertyId],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1,'channex',$2,'connected')",
      [propertyId, providerPropertyId],
    );
    await seedChannexAssignmentFixture(db, propertyId);
  });
  afterAll(async () => {
    await db.query("BEGIN;SET LOCAL session_replication_role=replica");
    await clearChannexAssignmentFixture(db, propertyId);
    for (const table of [
      "platform.job_attempts",
      "platform.dead_letter_events",
      "platform.product_audit_events",
    ])
      await db.query(
        `DELETE FROM ${table} WHERE job_id IN(SELECT id FROM platform.jobs WHERE payload->>'propertyId'=$1)`,
        [propertyId],
      );
    await db.query("DELETE FROM platform.product_audit_events WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1", [propertyId]);
    await db.query("DELETE FROM pms.channel_operational_alerts WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM pms.channel_booking_mappings WHERE property_id=$1", [propertyId]);
    await db.query(
      "DELETE FROM booking.booking_guests WHERE guest_booking_id IN(SELECT id FROM booking.guest_bookings WHERE property_id=$1)",
      [propertyId],
    );
    await db.query("DELETE FROM booking.guest_bookings WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM pms.channel_connections WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM pms.channel_binding_claims WHERE property_id=$1", [propertyId]);
    await db.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await db.query("DELETE FROM identity.users WHERE id=$1", [userId]);
    await db.query("COMMIT");
    await commands.close?.();
    await db.end();
  });
  async function fixture(roomCount = 1) {
    const selected = {
      providerPropertyId,
      channelBookingId: randomUUID(),
      revision: randomUUID(),
      approvalRef: "VAY-846:test",
    };
    const revision = {
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
        rooms: Array.from({ length: roomCount }, () => ({
          room_type_id: "provider-room",
          rate_plan_id: "provider-rate",
          occupancy: { adults: 1, children: 0 },
        })),
      },
    };
    const request = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "POST"
        ? new Response(null, { status: 204 })
        : Response.json({ data: revision }),
    );
    expect(await importChannexStagingReservation(config(), selected, request)).toMatchObject({
      status: "succeeded",
    });
    const canonicalBookingId = (
      await db.query(
        "SELECT guest_booking_id FROM pms.channel_booking_mappings WHERE property_id=$1 AND external_booking_id=$2",
        [propertyId, selected.channelBookingId],
      )
    ).rows[0].guest_booking_id;
    const alertId = (
      await db.query(
        `INSERT INTO pms.channel_operational_alerts(property_id,connection_id,binding_generation,problem_key,event_type,impact,first_occurred_at,last_occurred_at)
      SELECT property_id,id,binding_generation,$2,'non_acked_booking',$3,now(),now() FROM pms.channel_connections WHERE property_id=$1 RETURNING id`,
        [
          propertyId,
          randomUUID(),
          { bookingId: selected.channelBookingId, revisionId: selected.revision },
        ],
      )
    ).rows[0].id;
    request.mockClear();
    return { input: { ...selected, canonicalBookingId, alertId }, request, revision };
  }
  it("requires approval and a PMS click, excludes ordinary workers, verifies real linked ACK and no-op replay", async () => {
    const f = await fixture();
    const recover = () => commands.recoverStagingAlert!(context, propertyId, f.input.alertId, 0);
    expect(await recover()).toMatchObject({ ok: false });
    const prepared = await stagingAlertRecovery(config(), f.input, f.request);
    expect(await stagingAlertRecovery(config(), f.input, f.request)).toEqual(prepared);
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
    ).rejects.toThrow("staging_alert_not_prepared");
    expect(
      (await listChannexAlerts(db, propertyId, true)).find((a) => a.id === f.input.alertId)
        ?.stagingRecoveryAvailable,
    ).toBe(true);
    expect(
      await commands.recoverStagingAlert!(context, randomUUID(), f.input.alertId, 0),
    ).toMatchObject({ ok: false });
    expect(await Promise.all([recover(), recover()])).toEqual([{ ok: true }, { ok: true }]);
    expect(
      (
        await db.query(
          "SELECT id FROM platform.jobs WHERE queue_name='pms.channex.webhooks' AND job_key=$1",
          [`alert:${f.input.alertId}:round:0`],
        )
      ).rows,
    ).toEqual([{ id: prepared.jobId }]);
    await runChannexBookingJobs(url!, {
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      ownsMutation: () => true,
      fetch: f.request,
    });
    expect(f.request).not.toHaveBeenCalled();
    const before = (
      await db.query("SELECT to_jsonb(b) data FROM booking.guest_bookings b WHERE id=$1", [
        f.input.canonicalBookingId,
      ])
    ).rows;
    // ACK failure must leave the incident unresolved and preserve retry state.
    f.request
      .mockImplementationOnce(async () => Response.json({ data: f.revision }))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }));
    expect(
      await stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
    ).toMatchObject({ status: "pending", attempts: 1 });
    expect(
      (await listChannexAlerts(db, propertyId, true)).find((a) => a.id === f.input.alertId)
        ?.resolvedAt,
    ).toBeNull();
    await db.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [prepared.jobId]);
    expect(
      await stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
    ).toMatchObject({ status: "succeeded", attempts: 2 });
    const calls = f.request.mock.calls.length;
    expect(
      (await listChannexAlerts(db, propertyId, true)).find((a) => a.id === f.input.alertId)
        ?.resolvedAt,
    ).not.toBeNull();
    expect(
      await stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
    ).toMatchObject({ status: "succeeded", replayed: true });
    expect(f.request).toHaveBeenCalledTimes(calls);
    expect(
      (
        await db.query("SELECT to_jsonb(b) data FROM booking.guest_bookings b WHERE id=$1", [
          f.input.canonicalBookingId,
        ])
      ).rows,
    ).toEqual(before);
  });
  it("refuses partial mapping or assignment loss after preparation without ACK", async () => {
    for (const loss of ["mapping", "assignment"]) {
      const f = await fixture(2);
      await stagingAlertRecovery(config(), f.input);
      expect(await commands.recoverStagingAlert!(context, propertyId, f.input.alertId, 0)).toEqual({
        ok: true,
      });
      f.request.mockImplementation(async (_url, init) => {
        expect(init?.method).not.toBe("POST");
        await db.query(
          loss === "mapping"
            ? "DELETE FROM pms.channel_booking_mappings WHERE guest_booking_id=$1 AND channel_room_index=1"
            : "UPDATE pms.channel_booking_mappings SET assignment_id=NULL WHERE guest_booking_id=$1 AND channel_room_index=1",
          [f.input.canonicalBookingId],
        );
        return Response.json({ data: f.revision });
      });
      expect(
        await stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
      ).not.toMatchObject({ status: "succeeded" });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(
        (await listChannexAlerts(db, propertyId, true)).find((a) => a.id === f.input.alertId)
          ?.resolvedAt,
      ).toBeNull();
    }
  });

  it("rejects expired approval and mapping drift before provider ACK or canonical mutation", async () => {
    const f = await fixture();
    const prepared = await stagingAlertRecovery(config(), f.input);
    await db.query(
      `UPDATE platform.jobs SET job_metadata=jsonb_set(job_metadata,'{stagingAlertRecovery,expiresAt}','"2000-01-01T00:00:00.000Z"') WHERE id=$1`,
      [prepared.jobId],
    );
    const recoveryState = async () =>
      (
        await db.query(
          `SELECT to_jsonb(a) alert, to_jsonb(j) job FROM pms.channel_operational_alerts a
         CROSS JOIN platform.jobs j WHERE a.id=$1 AND j.id=$2`,
          [f.input.alertId, prepared.jobId],
        )
      ).rows;
    const expiredState = await recoveryState();
    expect(
      await commands.recoverStagingAlert!(context, propertyId, f.input.alertId, 0),
    ).toMatchObject({ ok: false });
    await expect(
      stagingAlertRecovery(config(), { ...f.input, execute: true }, f.request),
    ).rejects.toThrow("staging_alert_not_prepared");
    expect(f.request).not.toHaveBeenCalled();
    expect(await recoveryState()).toEqual(expiredState);
    expect(expiredState[0].alert.resolved_at).toBeNull();
    const g = await fixture();
    await stagingAlertRecovery(config(), g.input);
    expect(await commands.recoverStagingAlert!(context, propertyId, g.input.alertId, 0)).toEqual({
      ok: true,
    });
    g.request.mockImplementation(async (_url, init) => {
      expect(init?.method).not.toBe("POST");
      await db.query(
        "UPDATE pms.channel_booking_mappings SET external_revision_id='changed' WHERE guest_booking_id=$1",
        [g.input.canonicalBookingId],
      );
      return Response.json({ data: g.revision });
    });
    expect(
      await stagingAlertRecovery(config(), { ...g.input, execute: true }, g.request),
    ).not.toMatchObject({ status: "succeeded" });
    expect(g.request).toHaveBeenCalledTimes(1);
  });
});
