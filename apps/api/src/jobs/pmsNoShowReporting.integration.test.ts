import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@vayada/backend-auth";
import {
  createNoShowReportingStore,
  loadNoShowEligibility,
  noShowIneligibility,
  NO_SHOW_QUEUE,
} from "../domains/pmsNoShowReporting.js";
import { runNoShowReport } from "./pmsNoShowReporting.js";
const url = process.env.TEST_DATABASE_URL;
if (url && !/test|verify/.test(new URL(url).pathname)) throw new Error("Test database required");
describe.skipIf(!url)("Booking.com no-show durable reporting", () => {
  const db = new pg.Pool({ connectionString: url }),
    p = randomUUID(),
    other = randomUUID(),
    room = randomUUID(),
    user = randomUUID(),
    connection = randomUUID();
  const store = createNoShowReportingStore(db),
    context = {
      actor: { internalUserId: user },
      audit: { requestId: "test-no-show" },
    } as RequestContext;
  let booking: string,
    external: string,
    posts = 0,
    mode = "success";
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      if (mode === "binding_changed")
        await db.query(
          "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE id=$1",
          [connection],
        );
      if (mode === "preflight_timeout") throw new Error("network");
      const row = (
        await db.query(
          "SELECT check_in::text,check_out::text FROM booking.guest_bookings WHERE id=$1",
          [booking],
        )
      ).rows[0];
      return Response.json({
        data: {
          id: external,
          attributes: {
            property_id: mode === "wrong_property" ? "wrong" : p,
            ota_name: "Booking.com",
            status: "new",
            arrival_date: row.check_in,
            departure_date: row.check_out,
            rooms: [{}],
          },
        },
      });
    }
    posts++;
    expect(JSON.parse(String(init?.body))).toEqual({ no_show_report: { waived_fees: false } });
    if (mode === "timeout") throw new Error("response lost");
    if (mode === "reject") return Response.json({ sensitive: "never persist" }, { status: 422 });
    if (mode === "limit") return Response.json({}, { status: 429 });
    return Response.json({ meta: { message: "Success" } });
  };
  const run = () =>
    runNoShowReport(
      db,
      { apiBaseUrl: "https://staging.example.invalid", apiKey: "synthetic", fetch: fetcher },
      "test-worker",
    );
  beforeAll(async () => {
    await db.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
      user,
      `${user}@example.invalid`,
    ]);
    for (const id of [p, other])
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Synthetic no-show test')",
        [id],
      );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [p],
    );
    await db.query(
      "INSERT INTO pms.room_types(id,property_id,name,currency,base_rate_amount) VALUES($1,$2,'Synthetic','EUR',100)",
      [room, p],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1::uuid,'channex',$1::text,'active','repair')",
      [p],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($1::uuid,$2::uuid,'channex','connected',$2::text)",
      [connection, p],
    );
  });
  afterAll(async () => {
    await db.end();
  });
  async function seed(channel = "booking_com") {
    booking = randomUUID();
    external = randomUUID();
    posts = 0;
    mode = "success";
    await db.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,check_in,check_out,currency,booking_channel,direct_booking_source)
      VALUES($1::uuid,$2::uuid,$1::text,'pms',$3,'confirmed',current_date,current_date+1,'EUR',$4,CASE WHEN $4='direct' THEN 'booking_engine' END)`,
      [booking, p, `channex:${p}:${external}`, channel],
    );
    await db.query(
      `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,assignment_status,assignment_payload)
      VALUES($1,$2,$3,'released','{"operationalStatus":"no_show"}')`,
      [p, booking, room],
    );
    await db.query(
      `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,mapping_metadata)
      VALUES($1,$2,$3,$4,$5::jsonb)`,
      [
        p,
        connection,
        booking,
        external,
        JSON.stringify({ providerSource: "BookingCom", providerPropertyId: p }),
      ],
    );
  }
  it.each(["pending", "running"])(
    "leaves other-property %s jobs untouched by a scoped worker",
    async (status) => {
      await seed();
      await store.submit(context, p, booking, false, false);
      await db.query(
        "UPDATE platform.jobs SET status=$2,locked_by='prior-worker',locked_at=now()-interval '10 minutes' WHERE resource_id=$1 AND queue_name=$3",
        [booking, status, NO_SHOW_QUEUE],
      );
      const before = (
        await db.query("SELECT * FROM platform.jobs WHERE resource_id=$1 AND queue_name=$2", [
          booking,
          NO_SHOW_QUEUE,
        ])
      ).rows;
      await runNoShowReport(
        db,
        { apiBaseUrl: "https://staging.channex.io", apiKey: "test", fetch: fetcher },
        "scoped-worker",
        other,
      );
      expect(
        (
          await db.query("SELECT * FROM platform.jobs WHERE resource_id=$1 AND queue_name=$2", [
            booking,
            NO_SHOW_QUEUE,
          ])
        ).rows,
      ).toEqual(before);
      expect(posts).toBe(0);
      // Clear this isolated fixture so it cannot affect later unscoped worker tests.
      await db.query(
        "UPDATE platform.jobs SET status='dead_lettered',finished_at=now(),locked_at=NULL,locked_by=NULL WHERE resource_id=$1 AND queue_name=$2",
        [booking, NO_SHOW_QUEUE],
      );
    },
  );

  it("delivers only the configured staging property's report", async () => {
    await seed();
    await store.submit(context, p, booking, false, false);
    await expect(
      runNoShowReport(
        db,
        { apiBaseUrl: "https://app.channex.io", apiKey: "test", fetch: fetcher },
        "scoped-worker",
        p,
      ),
    ).rejects.toThrow("exact staging URL");
    expect(posts).toBe(0);
    await runNoShowReport(
      db,
      { apiBaseUrl: "https://staging.channex.io", apiKey: "test", fetch: fetcher },
      "scoped-worker",
      p,
    );
    expect(posts).toBe(1);
    expect(await store.get(p, booking)).toMatchObject({ status: "submitted" });
  });

  it("replays concurrent requests, submits once, and keeps OTA confirmation unconfirmed", async () => {
    await seed();
    expect(await store.get(p, booking)).toMatchObject({
      eligible: true,
      status: "not_reported",
      localNoShow: true,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => store.submit(context, p, booking, false, false)),
    );
    expect(outcomes.every((x) => x?.status === "pending")).toBe(true);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.jobs WHERE resource_id=$1 AND queue_name=$2",
          [booking, NO_SHOW_QUEUE],
        )
      ).rows[0].n,
    ).toBe(1);
    await run();
    await run();
    expect(posts).toBe(1);
    expect(await store.get(p, booking)).toMatchObject({
      status: "submitted",
      retryable: false,
      waivedFees: false,
    });
    await expect(store.submit(context, p, booking, true, false)).rejects.toThrow("different fee");
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM platform.product_audit_events WHERE target_resource_id=$1",
          [booking],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it.each(["timeout", "reject"])(
    "does not retry %s or repeat the local transition",
    async (value) => {
      await seed();
      mode = value;
      await store.submit(context, p, booking, false, false);
      await run();
      await run();
      expect(posts).toBe(1);
      expect(await store.get(p, booking)).toMatchObject({
        status: "action_required",
        retryable: false,
        localNoShow: true,
      });
      await expect(store.submit(context, p, booking, false, true)).rejects.toThrow("unsafe");
      expect(
        (
          await db.query(
            "SELECT job_metadata::text AS data FROM platform.jobs WHERE resource_id=$1",
            [booking],
          )
        ).rows[0].data,
      ).not.toContain("sensitive");
    },
  );
  it("bounds rate-limit retries and permits an explicit retry of the same operation", async () => {
    await seed();
    mode = "limit";
    await store.submit(context, p, booking, false, false);
    for (let i = 0; i < 5; i++) {
      await run();
      await db.query("UPDATE platform.jobs SET run_after=now() WHERE resource_id=$1", [booking]);
    }
    expect(await store.get(p, booking)).toMatchObject({
      status: "action_required",
      retryable: true,
    });
    mode = "success";
    await store.submit(context, p, booking, false, true);
    await run();
    expect(posts).toBe(6);
    expect((await store.get(p, booking))?.status).toBe("submitted");
  });
  it("requires review after a worker dies with dispatch persisted", async () => {
    await seed();
    await store.submit(context, p, booking, false, false);
    await db.query(
      `UPDATE platform.jobs SET status='running',attempts_count=1,locked_by='gone',locked_at=now()-interval '6 minutes',job_metadata='{"dispatchStarted":true}' WHERE resource_id=$1`,
      [booking],
    );
    await run();
    expect(posts).toBe(0);
    expect(await store.get(p, booking)).toMatchObject({
      status: "action_required",
      retryable: false,
    });
  });
  it("denies other properties, direct bookings, inconsistent mappings and partial rooms", async () => {
    await seed();
    expect(await store.submit(context, other, booking, false, false)).toBeNull();
    expect(await store.get(other, booking)).toBeNull();
    await seed("direct");
    expect((await store.get(p, booking))?.eligible).toBe(false);
    await seed();
    await db.query("UPDATE booking.guest_bookings SET room_count=2 WHERE id=$1", [booking]);
    expect((await store.get(p, booking))?.eligible).toBe(false);
    await db.query("UPDATE booking.guest_bookings SET room_count=1 WHERE id=$1", [booking]);
    await db.query(
      "UPDATE pms.channel_booking_mappings SET mapping_metadata='{}' WHERE guest_booking_id=$1",
      [booking],
    );
    expect((await store.get(p, booking))?.eligible).toBe(false);
  });
  it("revalidates a binding changed while provider preflight is in flight", async () => {
    await seed();
    mode = "binding_changed";
    await store.submit(context, p, booking, false, false);
    await run();
    expect(posts).toBe(0);
    expect((await store.get(p, booking))?.status).toBe("action_required");
  });
  it("rejects a multi-room mapping when only one room has provider metadata", async () => {
    await seed();
    await db.query("UPDATE booking.guest_bookings SET room_count=2 WHERE id=$1", [booking]);
    await db.query(
      "INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,position,assignment_status,assignment_payload) VALUES($1,$2,$3,2,'released','{\"operationalStatus\":\"no_show\"}')",
      [p, booking, room],
    );
    await db.query(
      "INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,external_booking_id,channel_room_index,mapping_metadata) VALUES($1,$2,$3,$4,1,'{}')",
      [p, connection, booking, external],
    );
    expect((await store.get(p, booking))?.eligible).toBe(false);
    await expect(store.submit(context, p, booking, false, false)).rejects.toThrow("mapping");
  });
  it("does not send when live provider identity disagrees", async () => {
    await seed();
    mode = "wrong_property";
    await store.submit(context, p, booking, false, false);
    await run();
    expect(posts).toBe(0);
    expect((await store.get(p, booking))?.status).toBe("action_required");
  });
  it("uses property midnight and 48 elapsed hours across DST, excluding the deadline", async () => {
    await seed();
    await db.query(
      "UPDATE hotel_catalog.property_locations SET timezone='Europe/Berlin' WHERE property_id=$1",
      [p],
    );
    await db.query(
      "UPDATE booking.guest_bookings SET check_in='2026-03-29',check_out='2026-03-31' WHERE id=$1",
      [booking],
    );
    for (const [at, eligible] of [
      ["2026-03-28T22:59:59Z", false],
      ["2026-03-28T23:00:00Z", true],
      ["2026-03-30T22:59:59Z", true],
      ["2026-03-30T23:00:00Z", false],
    ] as const) {
      const row = await loadNoShowEligibility(db, p, booking, new Date(at));
      expect(noShowIneligibility(row!) === null, at).toBe(eligible);
    }
    await db.query(
      "UPDATE hotel_catalog.property_locations SET timezone='Etc/UTC' WHERE property_id=$1",
      [p],
    );
  });
});
