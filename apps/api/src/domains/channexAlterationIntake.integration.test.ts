import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistChannexAlteration,
  type ChannexAlterationScope,
} from "./channexAlterationIntake.js";

import { decideChannexAlteration } from "./channexAlterationDecisions.js";
import { runChannexAlterationReadback } from "../jobs/channexAlterations.js";
import { presentChannexAlteration } from "./channexAlterationPresentation.js";
import {
  enqueueChannexAlterationScan,
  runChannexAlterationIntake,
} from "../jobs/channexAlterationIntake.js";

import { createTargetBookingWebCheckoutAdapter } from "../routes/bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
describe.skipIf(!url)("Airbnb alteration intake (PostgreSQL)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const journalPool = new pg.Pool({ connectionString: url, max: 2 });
  const property = randomUUID(),
    connection = randomUUID(),
    generation = randomUUID();
  const externalProperty = randomUUID(),
    externalBooking = randomUUID(),
    booking = randomUUID();
  const room = randomUUID(),
    externalRoom = randomUUID();
  let scope: ChannexAlterationScope;
  const event = () => ({
    data: {
      id: scope.eventId,
      attributes: {
        property_id: externalProperty,
        event: "alteration_request",
        payload: {
          resolved: false,
          bms: {
            booking_id: externalBooking,
            property_id: externalProperty,
            arrival_date: "2026-10-01",
            departure_date: "2026-10-05",
            amount: "425.50" as string | null,
            currency: "EUR",
            rooms: [{ room_type_id: externalRoom, occupancy: { adults: 2, children: 1 } }],
          },
        },
      },
    },
  });
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status) VALUES($1::uuid,$1::text,'Alteration test','active')`,
      [property],
    );
    await pool.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')`,
      [property, externalProperty],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id,binding_generation) VALUES($1,$2,'channex','connected',$3,$4)`,
      [connection, property, externalProperty, generation],
    );
    await pool.query(
      `INSERT INTO pms.room_types(id,property_id,name,currency,base_rate_amount) VALUES($1,$2,'Test','EUR',100)`,
      [room, property],
    );
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id) VALUES($1,$2,$3,$4)`,
      [property, connection, room, externalRoom],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,booking_channel,lifecycle_status,check_in,check_out,currency,total_amount,adults,children) VALUES($1::uuid,$2,$1::text,'airbnb','confirmed','2026-10-01','2026-10-03','EUR',300,2,0)`,
      [booking, property],
    );
    await pool.query(
      `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,channel,channel_room_index,sync_status) VALUES($1,$2,$3,$4,'channex',0,'active')`,
      [property, connection, booking, externalBooking],
    );
  });
  beforeEach(async () => {
    await clearScanJobs();
    await pool.query(`DELETE FROM booking.booking_change_requests WHERE guest_booking_id=$1`, [
      booking,
    ]);
    scope = {
      propertyId: property,
      connectionId: connection,
      bindingGeneration: generation,
      providerPropertyId: externalProperty,
      eventId: randomUUID(),
    };
  });
  afterAll(async () => {
    await clearScanJobs();
    await pool.query(`DELETE FROM booking.booking_change_requests WHERE guest_booking_id=$1`, [
      booking,
    ]);
    await pool.query(`DELETE FROM pms.channel_booking_mappings WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM booking.guest_bookings WHERE id=$1`, [booking]);
    await pool.query(`DELETE FROM pms.channel_room_type_mappings WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM pms.room_types WHERE id=$1`, [room]);
    await pool.query(`DELETE FROM pms.channel_connections WHERE id=$1`, [connection]);
    await pool.query(`DELETE FROM pms.channel_binding_claims WHERE property_id=$1`, [property]);
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id=$1`, [property]);
    await pool.end();
    await journalPool.end();
  });
  const input = (changeRequestId: string, action: "accept" | "decline" = "accept") => ({
    propertyId: property,
    bookingId: booking,
    changeRequestId,
    actorUserId: randomUUID(),
    action,
    correlationId: "alteration-decision-test",
  });
  async function clearScanJobs() {
    await pool.query(
      `DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)`,
      [property],
    );
    await pool.query(`DELETE FROM platform.jobs WHERE property_id=$1`, [property]);
  }
  function scanPorts() {
    return {
      pool,
      ownsMutation: () => true,
      limit: 1,
      provider: {
        list: vi.fn(async () => ({ eventIds: [scope.eventId], hasMore: false })),
        read: vi.fn(async () => event()),
      },
    };
  }
  async function scanRow() {
    return (
      await pool.query(
        `SELECT id,status,attempts_count,job_metadata FROM platform.jobs WHERE property_id=$1`,
        [property],
      )
    ).rows[0];
  }
  async function scanDue() {
    await pool.query(`UPDATE platform.jobs SET run_after=now() WHERE property_id=$1`, [property]);
  }
  it("durably scans a binding, re-fetches events and deduplicates triggering delivery", async () => {
    const trigger = randomUUID();
    await enqueueChannexAlterationScan(pool, scope, trigger);
    await enqueueChannexAlterationScan(pool, scope, trigger);
    const config = scanPorts();
    expect(await runChannexAlterationIntake(config)).toMatchObject({ processed: 1 });
    expect(config.provider.read).toHaveBeenCalledWith(externalProperty, scope.eventId, undefined);
    expect((await scanRow()).status).toBe("succeeded");
    const requests = await pool.query(
      `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
      [booking],
    );
    expect(requests.rows).toHaveLength(1);
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    await runChannexAlterationIntake(config);
    expect(
      (
        await pool.query(
          `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows,
    ).toEqual(requests.rows);
  });
  it("commits the cursor with intake, and retries a failed page without partial requests", async () => {
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    const config = scanPorts();
    config.provider.list.mockResolvedValueOnce({
      eventIds: [scope.eventId, randomUUID()],
      hasMore: true,
    });
    config.provider.read
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce(new Error("provider secret detail"));
    expect(await runChannexAlterationIntake(config)).toMatchObject({ retried: 1 });
    expect(
      (
        await pool.query(
          `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows,
    ).toHaveLength(0);
    expect(await scanRow()).toMatchObject({
      attempts_count: 1,
      job_metadata: { page: 1, failure: "alteration_scan_failed" },
    });
    await scanDue();
    config.provider.list.mockResolvedValueOnce({ eventIds: [scope.eventId], hasMore: true });
    await runChannexAlterationIntake(config);
    expect(await scanRow()).toMatchObject({
      attempts_count: 0,
      status: "pending",
      job_metadata: { page: 2 },
    });
    await scanDue();
    config.provider.list.mockResolvedValueOnce({ eventIds: [], hasMore: false });
    await runChannexAlterationIntake(config);
    expect(config.provider.list).toHaveBeenLastCalledWith(externalProperty, 2, undefined);
    expect((await scanRow()).status).toBe("succeeded");
  });
  it("quarantines a replaced binding after bounded retries without provider reads", async () => {
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    await pool.query(
      `UPDATE platform.jobs SET payload=jsonb_set(payload,'{bindingGeneration}',to_jsonb($2::text)),max_attempts=2 WHERE property_id=$1`,
      [property, randomUUID()],
    );
    const config = scanPorts();
    expect(await runChannexAlterationIntake(config)).toMatchObject({ retried: 1 });
    await scanDue();
    expect(await runChannexAlterationIntake(config)).toMatchObject({ deadLettered: 1 });
    expect((await scanRow()).status).toBe("dead_lettered");
    expect(config.provider.list).not.toHaveBeenCalled();
  });
  it("preserves an exhausted pagination cursor and dead-letters instead of restarting", async () => {
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    await pool.query(
      `UPDATE platform.jobs SET job_metadata='{"page":10000}',max_attempts=1 WHERE property_id=$1`,
      [property],
    );
    const config = scanPorts();
    config.provider.list.mockResolvedValueOnce({ eventIds: [], hasMore: true });
    await runChannexAlterationIntake(config);
    await scanDue();
    expect(await runChannexAlterationIntake(config)).toMatchObject({ deadLettered: 1 });
    expect(await scanRow()).toMatchObject({
      status: "dead_lettered",
      job_metadata: { page: 10001 },
    });
    expect(config.provider.list).toHaveBeenCalledTimes(1);
  });
  it("rolls back a page when ownership is lost after provider fetch", async () => {
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    let owns = true;
    const config = scanPorts();
    config.ownsMutation = () => owns;
    config.provider.read.mockImplementationOnce(async () => {
      owns = false;
      return event();
    });
    await runChannexAlterationIntake(config);
    expect(await scanRow()).toMatchObject({
      status: "pending",
      attempts_count: 0,
      job_metadata: { page: 1 },
    });
    expect(
      (
        await pool.query(
          `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("skips an in-flight scan in a competing worker", async () => {
    await enqueueChannexAlterationScan(pool, scope, randomUUID());
    const config = scanPorts();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    config.provider.list.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { eventIds: [], hasMore: false };
    });
    const first = runChannexAlterationIntake(config);
    await started;
    try {
      expect(await runChannexAlterationIntake(config)).toMatchObject({ processed: 0 });
    } finally {
      release();
      await first;
    }
    expect(config.provider.list).toHaveBeenCalledTimes(1);
  });
  function ports() {
    return {
      pool,
      journalPool,
      assertAvailability: vi.fn(async () => {}),
      provider: {
        read: vi.fn(async () => ({ ok: true as const, state: "pending" as const })),
        resolve: vi.fn(async () => ({ ok: true as const, state: "accepted" as const })),
      },
    };
  }
  async function journal(id: string) {
    return (
      await pool.query(
        `SELECT requested_changes->'channex'->'decision' AS decision
      FROM booking.booking_change_requests WHERE id=$1`,
        [id],
      )
    ).rows[0].decision;
  }
  async function readbackRow(id: string) {
    return (
      await pool.query(
        `SELECT status,requested_changes AS changes,decided_at
      FROM booking.booking_change_requests WHERE id=$1`,
        [id],
      )
    ).rows[0];
  }
  async function makeDue(id: string) {
    await pool.query(
      `UPDATE booking.booking_change_requests
      SET requested_changes=requested_changes #- '{channex,readback}' WHERE id=$1`,
      [id],
    );
  }
  it.each(["declined", "withdrawn", "accepted"] as const)(
    "reads external %s without inventing staff intent or mutating the booking",
    async (state) => {
      const { requestId } = await persistChannexAlteration(pool, scope, event());
      const before = (
        await pool.query(`SELECT * FROM booking.guest_bookings WHERE id=$1`, [booking])
      ).rows;
      const provider = { read: vi.fn(async () => ({ ok: true as const, state })) };
      const config = { pool, provider, ownsMutation: () => true };
      expect(await runChannexAlterationReadback(config)).toMatchObject({ refreshed: 1 });
      const row = await readbackRow(requestId);
      expect(row.status).toBe(
        state === "accepted" ? "pending" : state === "withdrawn" ? "canceled" : "declined",
      );
      expect(row.changes.channex.decision).toBeUndefined();
      expect(presentChannexAlteration(row.changes, true, row.status)).toMatchObject({
        state: state === "accepted" ? "awaiting_confirmation" : state,
        allowedActions: [],
      });
      expect(
        (await pool.query(`SELECT * FROM booking.guest_bookings WHERE id=$1`, [booking])).rows,
      ).toEqual(before);
      expect(await runChannexAlterationReadback(config)).toMatchObject({ refreshed: 0 });
      expect(provider.read).toHaveBeenCalledTimes(1);
      await expect(decideChannexAlteration(ports(), input(requestId))).rejects.toThrow(
        "alteration_not_pending",
      );
    },
  );
  it("reconciles unknown sends by GET, preserving the original staff intent", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports();
    config.provider.resolve.mockRejectedValueOnce(new Error("lost response"));
    await expect(decideChannexAlteration(config, input(requestId))).rejects.toThrow(
      "lost response",
    );
    const original = await journal(requestId);
    const provider = {
      read: vi.fn(async () => ({ ok: true as const, state: "declined" as const })),
    };
    await runChannexAlterationReadback({ pool, provider, ownsMutation: () => true });
    expect(await journal(requestId)).toEqual({
      ...original,
      providerState: "declined",
      deliveryState: "resolved",
    });
    expect(config.provider.resolve).toHaveBeenCalledTimes(1);
    expect((await readbackRow(requestId)).status).toBe("declined");
  });
  it("backs off failed reads and rejects contradictory terminal observations", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const provider = {
      read: vi.fn(async () => ({ ok: true as const, state: "accepted" as const })),
    };
    const config = { pool, provider, ownsMutation: () => true };
    provider.read.mockRejectedValueOnce(new Error("network failure"));
    expect(await runChannexAlterationReadback(config)).toMatchObject({ deferred: 1 });
    const failed = await readbackRow(requestId);
    expect(Date.parse(failed.changes.channex.readback.nextCheckAt) - Date.now()).toBeGreaterThan(
      14 * 60_000,
    );
    await runChannexAlterationReadback(config);
    expect(provider.read).toHaveBeenCalledTimes(1);
    await makeDue(requestId);
    await runChannexAlterationReadback(config);
    await makeDue(requestId);
    expect(
      await runChannexAlterationReadback({
        ...config,
        provider: {
          read: async () => ({ ok: true, state: "pending" }),
        },
      }),
    ).toMatchObject({ deferred: 1 });
    const conflict = await readbackRow(requestId);
    expect(conflict.changes.channex.providerState).toBe("accepted");
    expect(conflict.changes.channex.readback.failure).toBe("provider_resolution_conflict");
  });
  it("skips staff-held locks and never reads a replaced binding", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const client = await pool.connect();
    const config = { pool, provider: ports().provider, ownsMutation: () => true };
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `channex-alteration-decision:${requestId}`,
      ]);
      expect(await runChannexAlterationReadback(config)).toMatchObject({ skipped: 1 });
      expect(config.provider.read).not.toHaveBeenCalled();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool.query(
      `UPDATE booking.booking_change_requests SET requested_changes=jsonb_set(requested_changes,
      '{channex,bindingGeneration}',to_jsonb($2::text)) WHERE id=$1`,
      [requestId, randomUUID()],
    );
    expect(await runChannexAlterationReadback(config)).toMatchObject({ deferred: 1 });
    expect(config.provider.read).not.toHaveBeenCalled();
  });
  it("preserves a staff-confirmed outcome after an earlier pending background observation", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports();
    await runChannexAlterationReadback({ ...config, ownsMutation: () => true });
    await decideChannexAlteration(config, input(requestId));
    await makeDue(requestId);
    expect(
      await runChannexAlterationReadback({
        ...config,
        ownsMutation: () => true,
        provider: { read: async () => ({ ok: true, state: "declined" }) },
      }),
    ).toMatchObject({ deferred: 1 });
    expect((await journal(requestId)).providerState).toBe("accepted");
    expect((await readbackRow(requestId)).status).toBe("pending");
  });
  it("can clarify an unknown resolution without reopening the request", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    await runChannexAlterationReadback({
      pool,
      ownsMutation: () => true,
      provider: {
        read: async () => ({ ok: true, state: "resolved_unknown" }),
      },
    });
    await makeDue(requestId);
    await runChannexAlterationReadback({
      pool,
      ownsMutation: () => true,
      provider: {
        read: async () => ({ ok: true, state: "pending" }),
      },
    });
    expect((await readbackRow(requestId)).changes.channex.providerState).toBe("resolved_unknown");
    await makeDue(requestId);
    expect(
      await runChannexAlterationReadback({
        pool,
        ownsMutation: () => true,
        provider: {
          read: async () => ({ ok: true, state: "declined" }),
        },
      }),
    ).toMatchObject({ refreshed: 1 });
    expect((await readbackRow(requestId)).status).toBe("declined");
  });
  it("serializes overlapping background batches and rechecks the persisted due time", async () => {
    await persistChannexAlteration(pool, scope, event());
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const config = {
      pool,
      ownsMutation: () => true,
      provider: {
        read: vi.fn(async () => {
          entered();
          await gate;
          return { ok: true as const, state: "pending" as const };
        }),
      },
    };
    const first = runChannexAlterationReadback(config);
    await started;
    try {
      expect(await runChannexAlterationReadback(config)).toMatchObject({ skipped: 1 });
    } finally {
      release();
      await first;
    }
    await runChannexAlterationReadback(config);
    expect(config.provider.read).toHaveBeenCalledTimes(1);
  });
  it("stops without storing observations when mutation ownership is lost during a read", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    let owns = true;
    const config = {
      pool,
      ownsMutation: () => owns,
      provider: {
        read: vi.fn(async () => {
          owns = false;
          return { ok: true as const, state: "declined" as const };
        }),
      },
    };
    await runChannexAlterationReadback(config);
    const row = await readbackRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.changes.channex.readback).toBeUndefined();
    await runChannexAlterationReadback(config);
    expect(config.provider.read).toHaveBeenCalledTimes(1);
  });
  it("dispatches staff decisions through the provider coordinator and returns safe state", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: url!,
      pool,
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      airbnbAlterations: { decide: (value) => decideChannexAlteration(config, value) },
    });
    try {
      expect(await adapter.findLatestChangeRequest(property, booking)).toMatchObject({
        providerRequest: { state: "pending", allowedActions: ["accept", "decline"] },
      });
      expect(
        await adapter.acceptChangeRequest(property, booking, requestId, {
          actorUserId: command.actorUserId,
          requestId: "staff-request",
          correlationId: "staff-request",
          idempotencyKey: "staff-request",
          fingerprint: "unused-provider-fingerprint",
          occurredAt: new Date(),
        }),
      ).toMatchObject({
        status: "pending",
        providerRequest: { state: "awaiting_confirmation", allowedActions: [] },
      });
      expect(config.provider.resolve).toHaveBeenCalledOnce();
    } finally {
      await adapter.close?.();
    }
  });
  it("commits intent and send marker before sending without applying the booking", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    const before = (
      await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
        booking,
      ])
    ).rows;
    config.provider.resolve.mockImplementation(async () => {
      expect(await journal(requestId)).toMatchObject({
        action: "accept",
        actorUserId: command.actorUserId,
        deliveryState: "unknown",
        sendStartedAt: expect.any(String),
      });
      return { ok: true, state: "accepted" };
    });
    expect(await decideChannexAlteration(config, command)).toMatchObject({
      providerState: "accepted",
      deliveryState: "resolved",
    });
    expect(config.assertAvailability).toHaveBeenCalledOnce();
    expect(await decideChannexAlteration(config, command)).toMatchObject({
      providerState: "accepted",
    });
    expect(config.provider.resolve).toHaveBeenCalledOnce();
    await expect(
      decideChannexAlteration(config, { ...command, action: "decline" }),
    ).rejects.toThrow("alteration_decision_conflict");
    expect(
      (
        await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
          booking,
        ])
      ).rows,
    ).toEqual(before);
  });
  it("never resends after a crashed provider call", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    config.provider.resolve.mockRejectedValueOnce(new Error("simulated crash"));
    await expect(decideChannexAlteration(config, command)).rejects.toThrow("simulated crash");
    expect(await journal(requestId)).toMatchObject({
      deliveryState: "unknown",
      sendStartedAt: expect.any(String),
    });
    expect(await decideChannexAlteration(config, command)).toMatchObject({
      deliveryState: "unknown",
      providerState: "pending",
    });
    expect(config.provider.resolve).toHaveBeenCalledOnce();
  });
  it("preserves actual opposite provider resolution without sending", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports();
    const provider = {
      ...config.provider,
      read: vi.fn(async () => ({ ok: true as const, state: "declined" as const })),
    };
    expect(await decideChannexAlteration({ ...config, provider }, input(requestId))).toMatchObject({
      action: "accept",
      providerState: "declined",
      deliveryState: "resolved",
      sendStartedAt: null,
    });
    expect(provider.resolve).not.toHaveBeenCalled();
    expect(config.assertAvailability).not.toHaveBeenCalled();
  });
  it("defaults to the real availability guard before sending", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const { assertAvailability: _testOverride, ...config } = ports();
    await expect(decideChannexAlteration(config, input(requestId))).rejects.toThrow(
      "alteration_assignment_evidence_incomplete",
    );
    expect(config.provider.resolve).not.toHaveBeenCalled();
    expect(await journal(requestId)).toMatchObject({
      deliveryState: "queued",
      sendStartedAt: null,
    });
  });
  it("fails closed on availability and allows a safe retry before any send", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    config.assertAvailability.mockRejectedValueOnce(new Error("unavailable"));
    await expect(decideChannexAlteration(config, command)).rejects.toThrow("unavailable");
    expect(config.provider.resolve).not.toHaveBeenCalled();
    expect(await journal(requestId)).toMatchObject({
      deliveryState: "queued",
      sendStartedAt: null,
    });
    await decideChannexAlteration(config, command);
    expect(config.provider.resolve).toHaveBeenCalledOnce();
  });
  it("denies cross-property commands without contacting the provider", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports();
    await expect(
      decideChannexAlteration(config, { ...input(requestId), propertyId: randomUUID() }),
    ).rejects.toThrow("alteration_not_found");
    expect(config.provider.read).not.toHaveBeenCalled();
    expect(await journal(requestId)).toBeNull();
  });
  it("does not bypass binding checks during readback", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    config.provider.resolve.mockRejectedValueOnce(new Error("crash"));
    await expect(decideChannexAlteration(config, command)).rejects.toThrow("crash");
    await pool.query(`UPDATE pms.channel_connections SET binding_generation=$2 WHERE id=$1`, [
      connection,
      randomUUID(),
    ]);
    config.provider.read.mockClear();
    try {
      await expect(decideChannexAlteration(config, command)).rejects.toThrow(
        "alteration_connection_or_booking_changed",
      );
      expect(config.provider.read).not.toHaveBeenCalled();
    } finally {
      await pool.query(`UPDATE pms.channel_connections SET binding_generation=$2 WHERE id=$1`, [
        connection,
        generation,
      ]);
    }
  });
  it("commits the send marker with every worker connection occupied", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const singleWorkerPool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      expect(
        await decideChannexAlteration({ ...ports(), pool: singleWorkerPool }, input(requestId)),
      ).toMatchObject({ deliveryState: "resolved", providerState: "accepted" });
    } finally {
      await singleWorkerPool.end();
    }
  });
  it("concurrent callers cannot send twice", async () => {
    const { requestId } = await persistChannexAlteration(pool, scope, event());
    const config = ports(),
      command = input(requestId);
    const results = await Promise.allSettled([
      decideChannexAlteration(config, command),
      decideChannexAlteration(config, {
        ...command,
        changeRequestId: command.changeRequestId.toUpperCase(),
      }),
      decideChannexAlteration(config, command),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).not.toHaveLength(0);
    expect(config.provider.resolve).toHaveBeenCalledOnce();
  });
  it("stores a sanitized proposal without changing the booking and deduplicates concurrent delivery", async () => {
    const before = (
      await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
        booking,
      ])
    ).rows;
    const value = event();
    Object.assign(value.data.attributes.payload.bms, {
      raw_message: { credit_card: "must not persist" },
    });
    const results = await Promise.all([
      persistChannexAlteration(pool, scope, value),
      persistChannexAlteration(pool, scope, value),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.requestId).toBe(results[1]!.requestId);
    const rows = (
      await pool.query(
        `SELECT requested_changes FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
        [booking],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_changes).toMatchObject({
      oldTotal: "300.00",
      newTotal: "425.50",
      priceDifference: "125.50",
      requestedAdults: 2,
      requestedChildren: 1,
    });
    expect(JSON.stringify(rows)).not.toContain("credit_card");
    expect(
      (
        await pool.query(`SELECT to_jsonb(b) AS value FROM booking.guest_bookings b WHERE id=$1`, [
          booking,
        ])
      ).rows,
    ).toEqual(before);
  });
  it("keeps unknown price unknown", async () => {
    const value = event();
    value.data.attributes.payload.bms.amount = null;
    await persistChannexAlteration(pool, scope, value);
    expect(
      (
        await pool.query(
          `SELECT requested_changes FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows[0].requested_changes,
    ).toMatchObject({ newTotal: null, priceDifference: null });
  });
  it.each(["property", "generation", "booking", "room", "currency", "resolved", "dates"])(
    "rejects invalid %s without creating a request",
    async (kind) => {
      const value = event();
      if (kind === "property") value.data.attributes.property_id = randomUUID();
      if (kind === "generation") scope.bindingGeneration = randomUUID();
      if (kind === "booking") value.data.attributes.payload.bms.booking_id = randomUUID();
      if (kind === "room") value.data.attributes.payload.bms.rooms[0]!.room_type_id = randomUUID();
      if (kind === "currency") value.data.attributes.payload.bms.currency = "USD";
      if (kind === "resolved") value.data.attributes.payload.resolved = true;
      if (kind === "dates") value.data.attributes.payload.bms.departure_date = "2026-09-30";
      await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow();
      expect(
        (
          await pool.query(
            `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
            [booking],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it("rejects changed proposals and preserves terminal decisions on replay", async () => {
    const value = event();
    const result = await persistChannexAlteration(pool, scope, value);
    value.data.attributes.payload.bms.amount = "999.00";
    await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow(
      "alteration_identity_conflict",
    );
    await pool.query(
      `UPDATE booking.booking_change_requests SET status='declined',decided_at=now() WHERE id=$1`,
      [result.requestId],
    );
    expect(await persistChannexAlteration(pool, scope, event())).toEqual({
      ...result,
      replayed: true,
    });
    expect(
      (
        await pool.query(`SELECT status FROM booking.booking_change_requests WHERE id=$1`, [
          result.requestId,
        ])
      ).rows[0].status,
    ).toBe("declined");
  });
  it("serializes different concurrent events for the same booking", async () => {
    const first = event();
    const second = structuredClone(first);
    second.data.id = randomUUID();
    const results = await Promise.allSettled([
      persistChannexAlteration(pool, scope, first),
      persistChannexAlteration(pool, { ...scope, eventId: second.data.id }, second),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await pool.query(
          `SELECT id FROM booking.booking_change_requests WHERE guest_booking_id=$1`,
          [booking],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rejects a disconnected binding", async () => {
    await pool.query(
      `UPDATE pms.channel_connections SET connection_status='disconnected' WHERE id=$1`,
      [connection],
    );
    try {
      await expect(persistChannexAlteration(pool, scope, event())).rejects.toThrow(
        "alteration_connection_not_owned",
      );
    } finally {
      await pool.query(
        `UPDATE pms.channel_connections SET connection_status='connected' WHERE id=$1`,
        [connection],
      );
    }
  });
  it.each(["money", "occupancy"])("rejects malformed %s", async (kind) => {
    const value = event();
    if (kind === "money") value.data.attributes.payload.bms.amount = "NaN";
    else value.data.attributes.payload.bms.rooms[0]!.occupancy.adults = -1;
    await expect(persistChannexAlteration(pool, scope, value)).rejects.toThrow(
      "invalid_alteration_payload",
    );
  });
  it("rejects a second active request", async () => {
    await persistChannexAlteration(pool, scope, event());
    scope.eventId = randomUUID();
    await expect(persistChannexAlteration(pool, scope, event())).rejects.toThrow(
      "alteration_request_conflict",
    );
  });
});
