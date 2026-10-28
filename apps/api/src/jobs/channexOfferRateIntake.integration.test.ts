import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveChannexOfferRatePlan } from "../domains/channexOfferRateResolution.js";
import { createTargetPmsOperationsReadRepository } from "../domains/pmsOperationsReadModel.js";
import { createHotelSetupOrdinaryLoginFixture } from "../hotelSetupOrdinaryLogin.fixture.js";
import {
  clearChannexAssignmentFixture,
  seedChannexAssignmentFixture,
} from "./channexAssignmentTestFixture.js";
import { runChannexBookingJobs } from "./channexBookings.js";

// VAY-2108 (W2c): after the switch-day remap, OTA bookings name the Channex rate plans our
// published offers create. Intake resolves them through the offer target's active version.
const URL = process.env["TEST_DATABASE_URL"],
  P = "21080000-0000-4000-8000-0000000000c1",
  C = "21080000-0000-4000-8000-0000000000c2",
  B = "21080000-0000-4000-8000-0000000000c3",
  RETIRED = "21080000-0000-4000-8000-0000000000c4",
  CLOSED = "21080000-0000-4000-8000-0000000000c5",
  REMAPPED = "21080000-0000-4000-8000-0000000000c6",
  EXTERNAL = "chx-vay-2108-w2c";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

type Plan = { room: string; rate: string; binding?: string };

describe.skipIf(!URL)("Channex intake of offer-owned rate plans (PostgreSQL)", () => {
  type Revision = ReturnType<typeof revision>;
  const db = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 4 });
  let sequence = 0;
  let roomA = "";
  let legacyRate = "";
  const targets: Record<string, string> = {};
  const fetcher: typeof fetch = async (_input, init) =>
    (init?.method ?? "GET") === "GET"
      ? Response.json({ data: [] })
      : new Response(null, { status: 204 });

  beforeAll(async () => {
    await cleanup();
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay-2108-w2c','Offer intake')",
      [P],
    );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Athens')",
      [P],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [P, EXTERNAL],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($2,$1,'channex','connected',$3)",
      [P, C, EXTERNAL],
    );
    // Room A: the adopted CH- plan ("provider-rate" on "provider-room") from the shared fixture.
    ({ room: roomA, rate: legacyRate } = await seedChannexAssignmentFixture(db, P));
    // Room B: mapped to its own Channex room, sold only through offers.
    await room(B, "Offer room", "provider-room-b");
    await db.query(
      `WITH configured AS (SELECT set_config('session_replication_role','replica',true))
       INSERT INTO pms.operating_calendar_room_bindings(property_id,calendar_revision,room_type_id,
         source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
       SELECT $1,1,$2,1,1,100,100 FROM configured`,
      [P, B],
    );
    await db.query(
      `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
         effective_sellable_limit_count,inventory_revision,generated_sellable_limit_count,generated_source_revision,
         channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $1,$2,day,100,100,1,100,1,100,1,0,0,0,0 FROM generate_series('2026-09-01'::date,'2026-09-30'::date,'1 day') day`,
      [P, B],
    );
    // Room types the offer path must not land on: retired, closed, and one whose Channex room
    // was re-mapped after its offer was published.
    await room(RETIRED, "Retired room", "provider-room-retired", false);
    await room(CLOSED, "Closed room", "provider-room-closed");
    await withReplicaRole(async (client) => {
      await client.query(
        `INSERT INTO pms.room_type_closures(property_id,room_type_id,command_id,request_fingerprint,
           expected_room_facts_revision,expected_room_units_revision,previous_calendar_revision,
           closed_calendar_revision,cutoff_date,accepted_at,actor_user_id)
         VALUES($1,$2,gen_random_uuid(),repeat('a',64),1,1,1,2,'2026-08-01',now(),gen_random_uuid())`,
        [P, CLOSED],
      );
    });
    await room(REMAPPED, "Re-mapped room", "provider-room-remapped-new");

    targets["a"] = await seedOffer(
      roomA,
      "flex",
      [{ room: "provider-room", rate: "offer-rate-a" }],
      1,
    );
    targets["b"] = await seedOffer(
      B,
      "flex",
      [{ room: "provider-room-b", rate: "offer-rate-b" }],
      1,
    );
    // Sealed but never activated.
    await seedOffer(
      B,
      "inactive",
      [{ room: "provider-room-b", rate: "offer-rate-inactive" }],
      null,
    );
    // The active version moved to a new Channex plan; the old plan no longer resolves.
    targets["moved"] = await seedOffer(
      roomA,
      "moved",
      [
        { room: "provider-room", rate: "offer-rate-old" },
        { room: "provider-room", rate: "offer-rate-new" },
      ],
      2,
    );
    // Published under an earlier binding of the connection.
    const earlier = "21080000-0000-4000-8000-0000000000ff";
    await seedOffer(
      B,
      "stale",
      [{ room: "provider-room-b", rate: "offer-rate-stale", binding: earlier }],
      1,
    );
    await seedOffer(
      RETIRED,
      "flex",
      [{ room: "provider-room-retired", rate: "offer-rate-retired" }],
      1,
    );
    await seedOffer(
      CLOSED,
      "flex",
      [{ room: "provider-room-closed", rate: "offer-rate-closed" }],
      1,
    );
    await seedOffer(
      REMAPPED,
      "flex",
      [{ room: "provider-room-remapped-old", rate: "offer-rate-remapped" }],
      1,
    );
    // Moves on to a new Channex plan during the "accepted booking" case below.
    targets["later"] = await seedOffer(
      B,
      "later",
      [{ room: "provider-room-b", rate: "offer-rate-later-1" }],
      1,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("lands a new booking on an offer-owned plan on the offer's room type", async () => {
    await job(
      "offer-new",
      revision("offer-new-1", "offer-new", [["provider-room-b", "offer-rate-b"]]),
    );
    expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(await assignments("offer-new")).toEqual([
      { roomTypeId: B, ratePlanId: null, channexOffer: link("b", "1", "flex", B, "offer-rate-b") },
    ]);
    // The hotel sees the offer as the booking's rate (pms-web names it from the room's offers).
    expect(await rateNames("offer-new")).toEqual([{ ratePlanId: null, pricingOfferId: "flex" }]);

    // A new revision that changes only the guest keeps the stay and its offer link unwritten.
    const guestOnly = revision(
      "offer-new-2",
      "offer-new",
      [["provider-room-b", "offer-rate-b"]],
      "modified",
    );
    guestOnly.attributes.customer.name = "Grace";
    await job("offer-new", guestOnly);
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("offer-new")).toEqual([
      { roomTypeId: B, ratePlanId: null, channexOffer: link("b", "1", "flex", B, "offer-rate-b") },
    ]);
  });

  it("applies OTA alterations that move between legacy and offer plans", async () => {
    await job(
      "offer-alter",
      revision("offer-alter-1", "offer-alter", [["provider-room", "provider-rate"]]),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("offer-alter")).toEqual([
      { roomTypeId: roomA, ratePlanId: legacyRate, channexOffer: null },
    ]);

    const toOfferB = revision(
      "offer-alter-2",
      "offer-alter",
      [["provider-room-b", "offer-rate-b"]],
      "modified",
    );
    Object.assign(toOfferB.attributes, {
      arrival_date: "2026-09-02",
      departure_date: "2026-09-04",
    });
    Object.assign(toOfferB.attributes.rooms[0]!, {
      days: { "2026-09-02": "60.00", "2026-09-03": "60.00" },
    });
    await job("offer-alter", toOfferB);
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("offer-alter")).toEqual([
      { roomTypeId: B, ratePlanId: null, channexOffer: link("b", "1", "flex", B, "offer-rate-b") },
    ]);
    expect(await stay("offer-alter")).toEqual({ checkIn: "2026-09-02", checkOut: "2026-09-04" });

    await job(
      "offer-alter",
      revision("offer-alter-3", "offer-alter", [["provider-room", "offer-rate-a"]], "modified"),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("offer-alter")).toEqual([
      {
        roomTypeId: roomA,
        ratePlanId: null,
        channexOffer: link("a", "1", "flex", roomA, "offer-rate-a"),
      },
    ]);

    // Back on the adopted plan, the offer link of the earlier revision is gone.
    await job(
      "offer-alter",
      revision("offer-alter-4", "offer-alter", [["provider-room", "provider-rate"]], "modified"),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("offer-alter")).toEqual([
      { roomTypeId: roomA, ratePlanId: legacyRate, channexOffer: null },
    ]);
  });

  it("keeps adopted CH- plans working beside offers on the same room", async () => {
    await job(
      "side-by-side",
      revision("side-by-side-1", "side-by-side", [
        ["provider-room", "provider-rate"],
        ["provider-room", "offer-rate-a"],
        ["provider-room", "offer-rate-new"],
      ]),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("side-by-side")).toEqual([
      { roomTypeId: roomA, ratePlanId: legacyRate, channexOffer: null },
      {
        roomTypeId: roomA,
        ratePlanId: null,
        channexOffer: link("a", "1", "flex", roomA, "offer-rate-a"),
      },
      {
        roomTypeId: roomA,
        ratePlanId: null,
        channexOffer: link("moved", "2", "moved", roomA, "offer-rate-new"),
      },
    ]);
  });

  it("keeps taking OTA changes to an accepted booking after its offer moves to a new plan", async () => {
    await job(
      "accepted",
      revision("accepted-1", "accepted", [["provider-room-b", "offer-rate-later-1"]]),
    );
    expect((await run()).succeeded).toBe(1);
    // A second booking with two rooms, one on the offer and one on the adopted plan.
    await job(
      "accepted-multi",
      revision("accepted-multi-1", "accepted-multi", [
        ["provider-room-b", "offer-rate-later-1"],
        ["provider-room", "provider-rate"],
      ]),
    );
    expect((await run()).succeeded).toBe(1);
    // A new version with a new Channex plan becomes active, and the old plan is superseded.
    await addVersion(
      targets["later"]!,
      2,
      { room: "provider-room-b", rate: "offer-rate-later-2" },
      true,
    );

    const changed = revision(
      "accepted-2",
      "accepted",
      [["provider-room-b", "offer-rate-later-1"]],
      "modified",
    );
    Object.assign(changed.attributes, { arrival_date: "2026-09-05", departure_date: "2026-09-07" });
    Object.assign(changed.attributes.rooms[0]!, {
      days: { "2026-09-05": "60.00", "2026-09-06": "60.00" },
    });
    await job("accepted", changed);
    expect((await run()).succeeded).toBe(1);
    expect(await stay("accepted")).toEqual({ checkIn: "2026-09-05", checkOut: "2026-09-07" });
    expect(await assignments("accepted")).toEqual([
      {
        roomTypeId: B,
        ratePlanId: null,
        channexOffer: link("later", "1", "later", B, "offer-rate-later-1"),
      },
    ]);

    // The OTA reorders the rooms of the two-room booking: the offer room still resolves.
    await job(
      "accepted-multi",
      revision(
        "accepted-multi-2",
        "accepted-multi",
        [
          ["provider-room", "provider-rate"],
          ["provider-room-b", "offer-rate-later-1"],
        ],
        "modified",
      ),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("accepted-multi")).toEqual([
      { roomTypeId: roomA, ratePlanId: legacyRate, channexOffer: null },
      {
        roomTypeId: B,
        ratePlanId: null,
        channexOffer: link("later", "1", "later", B, "offer-rate-later-1"),
      },
    ]);

    // A new booking on the superseded plan still refuses; the active plan lands.
    const refused = await job(
      "accepted-new-old",
      revision("accepted-new-old-1", "accepted-new-old", [
        ["provider-room-b", "offer-rate-later-1"],
      ]),
      1,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await refusal(refused, "accepted-new-old")).toEqual({
      code: "operational_mapping_unavailable",
      bookings: 0,
    });
    await job(
      "accepted-new",
      revision("accepted-new-1", "accepted-new", [["provider-room-b", "offer-rate-later-2"]]),
    );
    expect((await run()).succeeded).toBe(1);
    expect(await assignments("accepted-new")).toEqual([
      {
        roomTypeId: B,
        ratePlanId: null,
        channexOffer: link("later", "2", "later", B, "offer-rate-later-2"),
      },
    ]);
  });

  it("names the offer only while the stay keeps its room type and Channex plan", async () => {
    await job("display", revision("display-1", "display", [["provider-room-b", "offer-rate-b"]]));
    expect((await run()).succeeded).toBe(1);
    expect(await rateNames("display")).toEqual([{ ratePlanId: null, pricingOfferId: "flex" }]);
    const id = await bookingId("display");
    // An Airbnb alteration that kept the room type records the new plan in channexStay only.
    await withReplicaRole((client) =>
      client.query(
        `UPDATE pms.operational_booking_assignments
         SET assignment_payload=jsonb_set(assignment_payload,'{channexStay,externalRatePlanId}','"other-rate"')
         WHERE guest_booking_id=$1::uuid`,
        [id],
      ),
    );
    expect(await rateNames("display")).toEqual([{ ratePlanId: null, pricingOfferId: null }]);
    // A move to another room type (by staff or an OTA) drops the offer name too.
    await withReplicaRole((client) =>
      client.query(
        `UPDATE pms.operational_booking_assignments
         SET room_type_id=$2::uuid,
           assignment_payload=jsonb_set(assignment_payload,'{channexStay,externalRatePlanId}','"offer-rate-b"')
         WHERE guest_booking_id=$1::uuid`,
        [id, roomA],
      ),
    );
    expect(await rateNames("display")).toEqual([{ ratePlanId: null, pricingOfferId: null }]);
  });

  it("still refuses a plan nobody owns", async () => {
    const id = await job(
      "unknown",
      revision("unknown-1", "unknown", [["provider-room", "unknown-rate"]]),
      1,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await refusal(id, "unknown")).toEqual({
      code: "operational_mapping_unavailable",
      bookings: 0,
    });
  });

  it.each([
    ["a plan whose offer belongs to another room type", "provider-room", "offer-rate-b"],
    [
      "a sealed plan of a target that was never activated",
      "provider-room-b",
      "offer-rate-inactive",
    ],
    ["the plan of a superseded version", "provider-room", "offer-rate-old"],
    ["a plan published under an earlier binding", "provider-room-b", "offer-rate-stale"],
    ["a plan of a retired room type", "provider-room-retired", "offer-rate-retired"],
    ["a plan of a closed room type", "provider-room-closed", "offer-rate-closed"],
    [
      "a plan whose room type now maps to another Channex room",
      "provider-room-remapped-old",
      "offer-rate-remapped",
    ],
  ])("refuses %s instead of guessing", async (_case, channexRoom, rate) => {
    const channelBookingId = `refused-${rate}`;
    const id = await job(
      channelBookingId,
      revision(`${channelBookingId}-1`, channelBookingId, [[channexRoom, rate]]),
      1,
    );
    expect((await run()).deadLettered).toBe(1);
    expect(await refusal(id, channelBookingId)).toEqual({
      code: "operational_mapping_unavailable",
      bookings: 0,
    });
  });

  it("resolves on a login shaped like the production API role, without a new grant", async () => {
    const login = await createHotelSetupOrdinaryLoginFixture(db, URL!);
    const pool = new pg.Pool({ connectionString: login.connectionString, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const rows = await resolveChannexOfferRatePlan(client, {
          propertyId: P,
          connectionId: C,
          externalRoomTypeId: "provider-room-b",
          externalRatePlanId: "offer-rate-b",
          priorTargetIds: [],
        });
        expect(rows).toEqual([
          {
            roomTypeId: B,
            ratePlanId: null,
            channexOffer: link("b", "1", "flex", B, "offer-rate-b"),
          },
        ]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await login.drop();
    }
  });

  // VAY-2108 W1d: an offer-plan stay goes through the same closed-night landing as a legacy one.
  it("lands an offer-plan booking on a closed night with the warning and the alert", async () => {
    const close = (status: "closed" | "open") =>
      withReplicaRole((client) =>
        client.query(
          `UPDATE pms.inventory_days SET status=$3,available_count=CASE WHEN $3='closed' THEN 0 ELSE total_count-assigned_count-blocked_count END
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-09-02'`,
          [P, B, status],
        ),
      );
    await close("closed");
    try {
      await job(
        "offer-closed",
        revision("offer-closed-1", "offer-closed", [["provider-room-b", "offer-rate-b"]]),
      );
      expect(await run()).toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
      expect(
        (
          await db.query(
            `SELECT assignment_payload->>'inventoryWarning' AS warning,assignment_payload ? 'channexOffer' AS offer
             FROM pms.operational_booking_assignments WHERE guest_booking_id=$1::uuid`,
            [await bookingId("offer-closed")],
          )
        ).rows,
      ).toEqual([{ warning: "closed", offer: true }]);
      expect(
        (
          await db.query(
            `SELECT event_type AS type,impact->>'roomTypeNames' AS rooms FROM pms.channel_operational_alerts
             WHERE property_id=$1 AND impact->>'bookingId'='offer-closed'`,
            [P],
          )
        ).rows,
      ).toEqual([{ type: "booking_on_closed_night", rooms: "Offer room" }]);
    } finally {
      await close("open");
    }
  });

  function link(
    target: string,
    version: string,
    offerId: string,
    roomTypeId: string,
    rate: string,
  ) {
    return { targetId: targets[target], version, offerId, roomTypeId, externalRatePlanId: rate };
  }

  async function room(id: string, name: string, channexRoom: string, active = true) {
    await db.query(
      "INSERT INTO pms.room_types(id,property_id,name,currency,base_rate_amount,active) VALUES($1,$2,$3,'EUR',100,$4)",
      [id, P, name, active],
    );
    await db.query(
      "INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id) VALUES($1,$2,$3,$4)",
      [P, C, id, channexRoom],
    );
  }

  async function seedOffer(
    roomTypeId: string,
    offerId: string,
    plans: readonly Plan[],
    activeVersion: number | null,
  ): Promise<string> {
    const target = (
      await db.query<{ id: string }>(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4) RETURNING id::text",
        [P, C, roomTypeId, offerId],
      )
    ).rows[0]!.id;
    for (const [index, plan] of plans.entries())
      await addVersion(target, index + 1, plan, activeVersion === index + 1);
    return target;
  }

  async function addVersion(target: string, version: number, plan: Plan, activate: boolean) {
    // The real triggers run: the intent numbers the version, sealing claims the plan's ownership.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const intent = (
        await client.query<{ id: string; version: string }>(
          `INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal)
           VALUES($1,$2,'{"offerId":"w2c"}') RETURNING id::text,version::text`,
          [target, `w2c-${version}`],
        )
      ).rows[0]!;
      expect(intent.version).toBe(String(version));
      await client.query(
        `INSERT INTO pms.channex_offer_target_versions(target_id,version,intent_id,binding_generation,
           external_property_id,external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
         SELECT $1,$2,$3,COALESCE($4::uuid,binding_generation),external_property_id,$5,$6,
           '{"title":"Offer"}','{"verified":true}'
         FROM pms.channel_connections WHERE id=$7`,
        [target, version, intent.id, plan.binding ?? null, plan.room, plan.rate, C],
      );
      if (activate)
        await client.query("UPDATE pms.channex_offer_targets SET active_version=$2 WHERE id=$1", [
          target,
          version,
        ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function run() {
    return runChannexBookingJobs(URL!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "secret",
      ownsMutation: () => true,
      fetch: fetcher,
      workerId: "vay-2108-w2c",
      limit: 1,
    });
  }

  async function job(channelBookingId: string, value: Revision, maxAttempts = 5): Promise<string> {
    const row = await db.query<{ id: string }>(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,
         correlation_id,max_attempts,payload)
       VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,'vay-2108-w2c',$3,$4)
       RETURNING id::text`,
      [
        `vay-2108-w2c:${++sequence}`,
        channelBookingId,
        maxAttempts,
        {
          propertyId: P,
          providerPropertyId: EXTERNAL,
          channelBookingId,
          revision: String(value.id),
          revisionSource: "revision_feed",
          pullRequired: false,
          rawPayload: { event: "booking", payload: value },
        },
      ],
    );
    return row.rows[0]!.id;
  }

  function revision(
    id: string,
    channelBookingId: string,
    rooms: readonly (readonly [string, string])[],
    status: "new" | "modified" = "new",
  ) {
    return {
      id,
      type: "booking_revision",
      attributes: {
        property_id: EXTERNAL,
        booking_id: channelBookingId,
        status,
        arrival_date: "2026-09-01",
        departure_date: "2026-09-03",
        amount: `${rooms.length * 120}.00`,
        currency: "EUR",
        inserted_at: new Date(Date.UTC(2026, 7, 20, 12, 0, sequence)).toISOString(),
        ota_name: "BookingCom",
        customer: { name: "Ada", surname: "Guest", mail: "guest@example.test", phone: "+100" },
        rooms: rooms.map(([roomTypeId, ratePlanId]) => ({
          room_type_id: roomTypeId,
          rate_plan_id: ratePlanId,
          occupancy: { adults: 1, children: 0 },
          days: { "2026-09-01": "60.00", "2026-09-02": "60.00" } as Record<string, string>,
        })),
      },
    };
  }

  async function bookingId(channelBookingId: string): Promise<string | undefined> {
    return (
      await db.query<{ id: string }>(
        "SELECT id::text FROM booking.guest_bookings WHERE source_booking_id=$1",
        [`channex:${P}:${channelBookingId}`],
      )
    ).rows[0]?.id;
  }

  async function assignments(channelBookingId: string) {
    return (
      await db.query(
        `SELECT room_type_id::text AS "roomTypeId",rate_plan_id::text AS "ratePlanId",
           assignment_payload->'channexOffer' AS "channexOffer"
         FROM pms.operational_booking_assignments
         WHERE guest_booking_id=$1::uuid AND assignment_status<>'released' ORDER BY position`,
        [await bookingId(channelBookingId)],
      )
    ).rows;
  }

  async function stay(channelBookingId: string) {
    return (
      await db.query(
        `SELECT check_in::text AS "checkIn",check_out::text AS "checkOut" FROM booking.guest_bookings WHERE id=$1::uuid`,
        [await bookingId(channelBookingId)],
      )
    ).rows[0];
  }

  async function rateNames(channelBookingId: string) {
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: URL!,
      pool: db,
    });
    const reservation = await repository.findReservationByGuestBookingId(
      P,
      (await bookingId(channelBookingId))!,
    );
    return reservation?.assignments.map(({ ratePlanId, pricingOfferId }) => ({
      ratePlanId,
      pricingOfferId,
    }));
  }

  async function refusal(jobId: string, channelBookingId: string) {
    return (
      await db.query<{ code: string; bookings: number }>(
        `SELECT job.job_metadata->>'lastErrorCode' AS code,
           (SELECT count(*)::int FROM booking.guest_bookings WHERE source_booking_id=$2) AS bookings
         FROM platform.jobs job WHERE job.id=$1::uuid`,
        [jobId, `channex:${P}:${channelBookingId}`],
      )
    ).rows[0];
  }

  async function withReplicaRole<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanup() {
    await withReplicaRole(async (client) => {
      await client.query(
        "DELETE FROM pms.channex_external_rate_owners WHERE connection_id=$1::uuid",
        [C],
      );
      for (const statement of [
        "DELETE FROM pms.channex_offer_target_versions WHERE target_id IN (SELECT id FROM pms.channex_offer_targets WHERE property_id=$1::uuid)",
        "DELETE FROM pms.channex_offer_target_intents WHERE target_id IN (SELECT id FROM pms.channex_offer_targets WHERE property_id=$1::uuid)",
        "DELETE FROM pms.channex_offer_targets WHERE property_id=$1::uuid",
        "DELETE FROM pms.room_type_closures WHERE property_id=$1::uuid",
        "DELETE FROM platform.product_audit_events WHERE redacted_payload->>'propertyId'=$1::text",
        "DELETE FROM platform.dead_letter_events WHERE job_id IN (SELECT id FROM platform.jobs WHERE payload->>'propertyId'=$1::text)",
        "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE payload->>'propertyId'=$1::text)",
        "DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1::text",
      ])
        await client.query(statement, [P]);
      await clearChannexAssignmentFixture(client as unknown as pg.Pool, P);
      for (const statement of [
        "DELETE FROM pms.channel_booking_revision_tombstones WHERE property_id=$1::uuid",
        "DELETE FROM pms.channel_booking_mappings WHERE property_id=$1::uuid",
        "DELETE FROM finance.ota_commission_evidence WHERE property_id=$1::uuid",
        "DELETE FROM booking.guest_bookings WHERE property_id=$1::uuid",
        "DELETE FROM pms.channel_connections WHERE property_id=$1::uuid",
        "DELETE FROM pms.channel_binding_claims WHERE property_id=$1::uuid",
        "DELETE FROM hotel_catalog.property_locations WHERE property_id=$1::uuid",
        "DELETE FROM hotel_catalog.properties WHERE id=$1::uuid",
      ])
        await client.query(statement, [P]);
    });
  }
});
