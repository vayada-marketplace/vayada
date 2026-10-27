import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPmsChannexManagementCommandPort } from "../domains/pmsChannexManagementCommandStore.js";
import {
  clearChannexAssignmentFixture,
  seedChannexAssignmentFixture,
} from "./channexAssignmentTestFixture.js";
import { runChannexBookingJobs, type ChannexBookingDeadLetter } from "./channexBookings.js";
import { runChannexFeedPulls } from "./channexFeedPull.js";

const URL = process.env["TEST_DATABASE_URL"];
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// VAY-2108 W1d: an OTA booking is never dropped without the hotel knowing. Dead letters raise a
// PMS alert, refused revisions never hide newer ones in the feed, and closed nights land.
const P = "21084000-0000-4000-8000-000000000001";
const C = "21084000-0000-4000-8000-000000000002";
const U = "21084000-0000-4000-8000-000000000003";
const EXTERNAL = "chx-w1d";
const API = "https://app.channex.io";

type Revision = { id: string; type: string; attributes: Record<string, unknown> };

describe.skipIf(!URL)("Channex booking alerts (PostgreSQL)", () => {
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 4 });
  const commands = createPgPmsChannexManagementCommandPort({
    connectionString: URL ?? "postgresql://disabled",
  });
  const context = {
    actor: { internalUserId: U },
    audit: { requestId: "vay2108-w1d", correlationId: "vay2108-w1d" },
  } as RequestContext;
  let sequence = 0;
  let feed: Revision[] = [];
  let upcoming: Array<{ id: string; revisionId: string }> = [];
  const revisions = new Map<string, Revision>();
  const calls: string[] = [];
  const reported: ChannexBookingDeadLetter[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(input)}`);
    const url = new globalThis.URL(String(input));
    if (method === "POST") return new Response(null, { status: 204 });
    if (url.pathname === "/api/v1/booking_revisions/feed") {
      const page = Number(url.searchParams.get("pagination[page]") ?? 1);
      const limit = Number(url.searchParams.get("pagination[limit]") ?? 10);
      return Response.json({
        data: feed.slice((page - 1) * limit, page * limit),
        meta: { page, limit, total: feed.length },
      });
    }
    if (url.pathname === "/api/v1/bookings")
      return Response.json({
        data: upcoming.map(({ id, revisionId }) => ({
          id,
          type: "booking",
          attributes: { property_id: EXTERNAL, revision_id: revisionId },
        })),
        meta: { page: 1, limit: 100, total: upcoming.length },
      });
    const found = revisions.get(url.pathname.split("/").at(-1)!);
    return found ? Response.json({ data: found }) : new Response(null, { status: 404 });
  };
  const run = () =>
    runChannexBookingJobs(URL!, {
      apiBaseUrl: API,
      apiKey: "secret",
      ownsMutation: () => true,
      fetch: fetcher,
      workerId: "vay2108-w1d",
      limit: 1,
      onDeadLetter: (deadLetter) => reported.push(deadLetter),
    });

  beforeAll(async () => {
    await cleanup();
    await db.query(
      "INSERT INTO identity.users(id,email,name) VALUES($1,'vay2108-w1d@example.test','W1d tester')",
      [U],
    );
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay2108-w1d','W1d alerts')",
      [P],
    );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Athens')",
      [P],
    );
    await db.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex',$2,'active','repair')`,
      [P, EXTERNAL],
    );
    await db.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id)
       VALUES($2,$1,'channex','connected',$3)`,
      [P, C, EXTERNAL],
    );
    await seedChannexAssignmentFixture(db, P);
  });
  afterAll(async () => {
    await cleanup();
    await Promise.all([db.end(), commands.close?.()]);
  });

  it("raises the hotel's alert with the dead letter, and a rolled-back dead letter raises none", async () => {
    const refused = revision("bk-unmapped", { rate: "provider-rate-late", reference: "BDC-1001" });
    await job(refused, { maxAttempts: 5 });
    expect(await run()).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(await alerts("bk-unmapped")).toEqual([
      {
        type: "booking_not_imported",
        resolved: false,
        impact: {
          bookingId: "bk-unmapped",
          revisionId: refused.id,
          channelId: null,
          channel: "BookingCom",
          reference: "BDC-1001",
          roomTypeId: "provider-room",
          ratePlanId: "provider-rate-late",
          dateFrom: "2026-09-01",
          dateTo: "2026-09-03",
          errorType: "operational_mapping_unavailable",
          revisionInsertedAt: expect.stringMatching(/^2026-08-20T12:00:\d\d\.000000Z$/),
        },
      },
    ]);
    expect(reported.at(-1)).toEqual({
      propertyId: P,
      channelBookingId: "bk-unmapped",
      code: "operational_mapping_unavailable",
      reason: "operational_mapping_unavailable",
      alerted: true,
    });
    // A refused revision is never acknowledged: Channex keeps flagging it as well.
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);

    await db.query(`CREATE FUNCTION pms.vay2108_w1d_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.resource_id='bk-rollback' THEN RAISE EXCEPTION 'forced dead-letter rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER vay2108_w1d_fail BEFORE INSERT ON platform.dead_letter_events
      FOR EACH ROW EXECUTE FUNCTION pms.vay2108_w1d_fail()`);
    const rollback = await job(revision("bk-rollback", { rate: "provider-rate-late" }), {
      maxAttempts: 1,
    });
    await expect(run()).rejects.toThrow("forced dead-letter rollback");
    expect(await alerts("bk-rollback")).toEqual([]);
    expect(await status(rollback)).toBe("running");
    await db.query(
      "DROP TRIGGER vay2108_w1d_fail ON platform.dead_letter_events; DROP FUNCTION pms.vay2108_w1d_fail()",
    );
    // The lease runs out with no attempt left: that dead letter raises the alert.
    await db.query("UPDATE platform.jobs SET locked_at=now()-interval '6 minutes' WHERE id=$1", [
      rollback,
    ]);
    expect(await run()).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(await status(rollback)).toBe("dead_lettered");
    expect(await alerts("bk-rollback")).toEqual([
      expect.objectContaining({
        type: "booking_not_imported",
        impact: expect.objectContaining({ errorType: "worker_lease_expired" }),
      }),
    ]);
    expect(reported.at(-1)).toMatchObject({
      propertyId: P,
      channelBookingId: "bk-rollback",
      reason: "worker_lease_expired",
      alerted: true,
    });
  });

  it("re-ingests the refused booking on Retry import once its rate is mapped", async () => {
    const [alert] = await alerts("bk-unmapped");
    const refused = revisions.get(alert!.impact["revisionId"] as string)!;
    const room = (
      await db.query<{ id: string }>(
        "SELECT id::text FROM pms.room_types WHERE property_id=$1 AND name='Channel room'",
        [P],
      )
    ).rows[0]!.id;
    const rate = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.rate_plans(property_id,room_type_id,code,name,currency)
         VALUES($1,$2,'channel-late','Late rate','EUR') RETURNING id::text`,
        [P, room],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO pms.channel_rate_plan_mappings(property_id,connection_id,room_type_id,rate_plan_id,external_room_type_id,external_rate_plan_id)
       VALUES($1,$2,$3,$4,'provider-room','provider-rate-late')`,
      [P, C, room, rate],
    );
    // Unacknowledged, the refused revision is still in the feed the recovery job reads.
    feed = [refused];
    expect(await commands.recoverAlert!(context, P, await alertId("bk-unmapped"), 0)).toEqual({
      ok: true,
    });
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await bookings("bk-unmapped")).toBe(1);
    expect((await alerts("bk-unmapped"))[0]).toMatchObject({ resolved: true });
    expect(calls).toContain(`POST ${API}/api/v1/booking_revisions/${refused.id}/ack`);
    feed = [];
  });

  it("pages past more than 100 refused revisions to reach the hinted one", async () => {
    const wanted = revision("bk-behind");
    feed = [...Array.from({ length: 150 }, (_, index) => revision(`bk-refused-${index}`)), wanted];
    calls.length = 0;
    await job(wanted, { pullRequired: true });
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await bookings("bk-behind")).toBe(1);
    expect(calls.filter((call) => call.includes("/feed?")).map(page)).toEqual([1, 2]);
    feed = [];
  });

  it("lands bookings on closed and linked stop-sell nights with the marker and the alert", async () => {
    await fixture(
      "UPDATE pms.inventory_days SET status='closed',available_count=0 WHERE property_id=$1 AND stay_date='2026-09-05'",
    );
    await job(revision("bk-closed", { checkIn: "2026-09-04", checkOut: "2026-09-06" }));
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await warnings("bk-closed")).toEqual(["closed"]);
    expect(await alerts("bk-closed")).toEqual([
      {
        type: "booking_on_closed_night",
        resolved: false,
        impact: expect.objectContaining({
          bookingId: "bk-closed",
          errorType: "inventory_closed",
          roomTypeNames: "Channel room",
          dateFrom: "2026-09-04",
          dateTo: "2026-09-06",
        }),
      },
    ]);
    // Counted against the room without selling the closed night: available stays 0.
    expect(await night("2026-09-05")).toEqual({ status: "closed", available: 0, assigned: 1 });

    await fixture(
      "UPDATE pms.inventory_days SET linked_stop_sell=true,linked_source_revision=1,available_count=0 WHERE property_id=$1 AND stay_date='2026-09-08'",
    );
    await job(revision("bk-linked", { checkIn: "2026-09-08", checkOut: "2026-09-09" }));
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await warnings("bk-linked")).toEqual(["linked_stop_sell"]);
    expect(await alerts("bk-linked")).toEqual([
      expect.objectContaining({
        type: "booking_on_closed_night",
        impact: expect.objectContaining({ errorType: "inventory_linked_stop_sell" }),
      }),
    ]);
  });

  it("lands an alteration onto a closed night and closes the alert when a later one moves off it", async () => {
    await job(revision("bk-alter", { checkIn: "2026-09-12", checkOut: "2026-09-13" }));
    expect((await run()).succeeded).toBe(1);
    expect(await warnings("bk-alter")).toEqual([null]);
    const onto = revision("bk-alter", {
      checkIn: "2026-09-05",
      checkOut: "2026-09-06",
      status: "modified",
    });
    await job(onto);
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await warnings("bk-alter")).toEqual(["closed"]);
    expect(await alerts("bk-alter")).toEqual([
      expect.objectContaining({ type: "booking_on_closed_night", resolved: false }),
    ]);
    await job(
      revision("bk-alter", { checkIn: "2026-09-14", checkOut: "2026-09-15", status: "modified" }),
    );
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await warnings("bk-alter")).toEqual([null]);
    expect(await alerts("bk-alter")).toEqual([
      expect.objectContaining({ type: "booking_on_closed_night", resolved: true }),
    ]);
  });

  it("lands a closed-night booking from the switch-day booking copy", async () => {
    const copied = revision("bk-copied", { checkIn: "2026-09-05", checkOut: "2026-09-07" });
    upcoming = [{ id: "bk-copied", revisionId: copied.id }];
    const generation = (
      await db.query<{ generation: string }>(
        "SELECT binding_generation::text AS generation FROM pms.channel_connections WHERE id=$1",
        [C],
      )
    ).rows[0]!.generation;
    await db.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,resource_product,
         resource_type,resource_id,max_attempts,payload)
       VALUES($1,'pms.channex.webhooks','channex.resync-bookings','property',$2::uuid,'pms','channel_connection',$2::uuid::text,3,
         jsonb_build_object('propertyId',$2::uuid::text,'providerPropertyId',$3::text,'bindingGeneration',$4::text))`,
      [`channex.resync-bookings:${P}:${generation}`, P, EXTERNAL, generation],
    );
    expect(
      await runChannexFeedPulls(URL!, {
        apiBaseUrl: API,
        apiKey: "secret",
        ownedPropertyIds: [P],
        excludedIds: [],
        workerId: "vay2108-w1d-pull",
        fetch: fetcher,
        resyncPaceMs: 0,
      }),
    ).toMatchObject({ resynced: 1, resyncFailed: 0, truncated: [] });
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await warnings("bk-copied")).toEqual(["closed"]);
    expect(await alerts("bk-copied")).toEqual([
      expect.objectContaining({ type: "booking_on_closed_night", resolved: false }),
    ]);
    upcoming = [];
  });

  it("still refuses more rooms than exist and nights beyond the open calendar, now with the alert", async () => {
    await fixture(
      "UPDATE pms.inventory_days SET blocked_count=total_count-assigned_count,available_count=0 WHERE property_id=$1 AND stay_date='2026-09-20'",
    );
    await job(revision("bk-full", { checkIn: "2026-09-20", checkOut: "2026-09-21" }), {
      maxAttempts: 1,
    });
    expect(await run()).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(await bookings("bk-full")).toBe(0);
    expect(await alerts("bk-full")).toEqual([
      expect.objectContaining({
        type: "booking_not_imported",
        impact: expect.objectContaining({ errorType: "operational_inventory_unavailable" }),
      }),
    ]);
    await job(revision("bk-unopened", { checkIn: "2026-12-01", checkOut: "2026-12-02" }), {
      maxAttempts: 1,
    });
    expect(await run()).toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(await alerts("bk-unopened")).toEqual([
      expect.objectContaining({
        type: "booking_not_imported",
        impact: expect.objectContaining({ errorType: "inventory_not_open" }),
      }),
    ]);
    expect(reported.at(-1)).toMatchObject({
      channelBookingId: "bk-unopened",
      code: "operational_inventory_unavailable",
      reason: "inventory_not_open",
      alerted: true,
    });
  });

  function revision(
    bookingId: string,
    options: {
      rate?: string;
      reference?: string;
      checkIn?: string;
      checkOut?: string;
      status?: string;
    } = {},
  ): Revision {
    sequence += 1;
    const checkIn = options.checkIn ?? "2026-09-01";
    const checkOut = options.checkOut ?? "2026-09-03";
    const value = {
      id: `21084000-0000-4000-9000-${String(sequence).padStart(12, "0")}`,
      type: "booking_revision",
      attributes: {
        property_id: EXTERNAL,
        booking_id: bookingId,
        status: options.status ?? "new",
        ota_name: "BookingCom",
        ota_reservation_code: options.reference ?? `BDC-${sequence}`,
        arrival_date: checkIn,
        departure_date: checkOut,
        amount: "120.00",
        currency: "EUR",
        inserted_at: new Date(Date.UTC(2026, 7, 20, 12, 0, sequence)).toISOString(),
        customer: { name: "Ada", surname: "Guest", mail: "guest@example.test" },
        rooms: [
          {
            room_type_id: "provider-room",
            rate_plan_id: options.rate ?? "provider-rate",
            occupancy: { adults: 1, children: 0 },
          },
        ],
      },
    };
    revisions.set(value.id, value);
    return value;
  }

  async function job(
    value: Revision,
    options: { pullRequired?: boolean; maxAttempts?: number } = {},
  ) {
    const pullRequired = options.pullRequired ?? false;
    const bookingId = String(value.attributes["booking_id"]);
    return (
      await db.query<{ id: string }>(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,correlation_id,max_attempts,payload)
         VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,'vay2108-w1d',$3,$4) RETURNING id::text`,
        [
          `vay2108-w1d:${sequence}:${value.id}`,
          bookingId,
          options.maxAttempts ?? 5,
          {
            propertyId: P,
            providerPropertyId: EXTERNAL,
            channelBookingId: bookingId,
            revision: value.id,
            revisionSource: pullRequired ? "webhook_hint" : "revision_feed",
            pullRequired,
            rawPayload: pullRequired
              ? { event: "booking" }
              : { event: "booking", payload: { ...value.attributes, id: value.id } },
          },
        ],
      )
    ).rows[0]!.id;
  }

  async function alerts(bookingId: string) {
    return (
      await db.query<{ type: string; resolved: boolean; impact: Record<string, unknown> }>(
        `SELECT event_type AS type,resolved_at IS NOT NULL AS resolved,impact
         FROM pms.channel_operational_alerts WHERE property_id=$1 AND impact->>'bookingId'=$2
         ORDER BY created_at`,
        [P, bookingId],
      )
    ).rows;
  }

  async function alertId(bookingId: string) {
    return (
      await db.query<{ id: string }>(
        "SELECT id::text FROM pms.channel_operational_alerts WHERE property_id=$1 AND impact->>'bookingId'=$2",
        [P, bookingId],
      )
    ).rows[0]!.id;
  }

  async function warnings(bookingId: string) {
    return (
      await db.query<{ warning: string | null }>(
        `SELECT a.assignment_payload->>'inventoryWarning' AS warning FROM pms.operational_booking_assignments a
         JOIN booking.guest_bookings b ON b.id=a.guest_booking_id WHERE b.source_booking_id=$1 ORDER BY a.position`,
        [`channex:${P}:${bookingId}`],
      )
    ).rows.map((row) => row.warning);
  }

  async function bookings(bookingId: string) {
    return (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM booking.guest_bookings WHERE source_booking_id=$1",
        [`channex:${P}:${bookingId}`],
      )
    ).rows[0]!.n;
  }

  async function night(stayDate: string) {
    return (
      await db.query(
        `SELECT status,available_count AS available,assigned_count AS assigned FROM pms.inventory_days
         WHERE property_id=$1 AND stay_date=$2 AND room_type_id=(SELECT id FROM pms.room_types WHERE property_id=$1 AND name='Channel room')`,
        [P, stayDate],
      )
    ).rows[0];
  }

  async function status(jobId: string) {
    return (await db.query("SELECT status FROM platform.jobs WHERE id=$1", [jobId])).rows[0]
      .status as string;
  }

  function page(call: string) {
    return Number(new globalThis.URL(call.slice(4)).searchParams.get("pagination[page]"));
  }

  async function fixture(sql: string) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(sql, [P]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanup() {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "DROP TRIGGER IF EXISTS vay2108_w1d_fail ON platform.dead_letter_events; DROP FUNCTION IF EXISTS pms.vay2108_w1d_fail()",
      );
      await clearChannexAssignmentFixture(client, P);
      const receipts = `SELECT id FROM platform.external_webhook_events WHERE provider='channex' AND provider_event_id LIKE '%${P}%'`;
      const jobs = `SELECT id FROM platform.jobs WHERE property_id='${P}' OR payload->>'propertyId'='${P}'`;
      for (const sql of [
        `DELETE FROM platform.idempotency_keys WHERE response_resource_type='external_webhook_event' AND response_resource_id IN (SELECT id::text FROM (${receipts}) r)`,
        `DELETE FROM platform.external_webhook_events WHERE id IN (${receipts})`,
        `DELETE FROM platform.domain_events WHERE event_key LIKE '%${P}%'`,
        `DELETE FROM platform.product_audit_events WHERE redacted_payload->>'propertyId'='${P}' OR property_id='${P}'`,
        `DELETE FROM platform.dead_letter_events WHERE job_id IN (${jobs})`,
        `DELETE FROM platform.job_attempts WHERE job_id IN (${jobs})`,
        `DELETE FROM platform.jobs WHERE id IN (${jobs})`,
        `DELETE FROM pms.channel_booking_revision_tombstones WHERE property_id='${P}'`,
        `DELETE FROM pms.channel_booking_mappings WHERE property_id='${P}'`,
        `DELETE FROM finance.ota_commission_evidence WHERE property_id='${P}'`,
        `DELETE FROM booking.booking_guests WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id='${P}')`,
        `DELETE FROM booking.guest_bookings WHERE property_id='${P}'`,
        `DELETE FROM pms.channel_connections WHERE property_id='${P}'`,
        `DELETE FROM pms.channel_binding_claims WHERE property_id='${P}'`,
        `DELETE FROM hotel_catalog.property_locations WHERE property_id='${P}'`,
        `DELETE FROM hotel_catalog.properties WHERE id='${P}'`,
        `DELETE FROM identity.users WHERE id='${U}'`,
      ])
        await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
