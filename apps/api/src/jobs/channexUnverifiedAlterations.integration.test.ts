import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedChannexAssignmentFixture } from "./channexAssignmentTestFixture.js";
import { decideChannexAlteration } from "../domains/channexAlterationDecisions.js";
import { runChannexBookingJobs } from "./channexBookings.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("unverified Airbnb alteration worker", () => {
  const db = new pg.Pool({ connectionString: url });
  const journalPool = new pg.Pool({ connectionString: url, max: 1 });
  const property = randomUUID(),
    connection = randomUUID(),
    external = randomUUID(),
    providerBooking = randomUUID(),
    providerRoom = randomUUID();
  let room: string,
    sequence = 0,
    acknowledgements = 0;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.includes("test"))
      throw new Error("Isolated test database required");
    await db.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Unverified alteration')",
      [property],
    );
    await db.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Athens')",
      [property],
    );
    await db.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [property, external],
    );
    await db.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($1,$2,'channex','connected',$3)",
      [connection, property, external],
    );
    ({ room } = await seedChannexAssignmentFixture(db, property));
    await db.query(
      "UPDATE pms.channel_room_type_mappings SET external_room_type_id=$2 WHERE property_id=$1",
      [property, providerRoom],
    );
    await db.query(
      "UPDATE pms.channel_rate_plan_mappings SET external_room_type_id=$2 WHERE property_id=$1",
      [property, providerRoom],
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      await client.query(
        "INSERT INTO pms.rooms(property_id,room_type_id,room_number) SELECT $1,$2,n::text FROM generate_series(1,100)n",
        [property, room],
      );
      await client.query(
        `INSERT INTO pms.inventory_materialization_coverage(property_id,organization_id,calendar_revision,materialized_revision,coverage_from,coverage_through,room_type_count,expected_day_count,materialized_day_count,last_changed_materialization_idempotency_key_id,last_changed_materialization_domain_event_id,last_changed_materialization_outbox_event_id,updated_at) VALUES($1,gen_random_uuid(),1,1,'2026-09-01','2026-09-30',1,30,30,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now())`,
        [property],
      );
      await client.query("UPDATE pms.inventory_days SET rate_gate_open=true WHERE property_id=$1", [
        property,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      for (const table of [
        "platform.product_audit_events",
        "platform.dead_letter_events",
        "platform.job_attempts",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE job_id IN (SELECT id FROM platform.jobs WHERE payload->>'propertyId'=$1)`,
          [property],
        );
      await client.query("DELETE FROM platform.jobs WHERE payload->>'propertyId'=$1", [property]);
      for (const table of ["booking.booking_change_requests", "booking.booking_guests"])
        await client.query(
          `DELETE FROM ${table} WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id=$1)`,
          [property],
        );
      for (const table of [
        "platform.outbox_events",
        "platform.domain_events",
        "finance.ota_commission_evidence",
        "booking.nightly_revenue_evidence",
        "booking.nightly_revenue_room_scopes",
        "pms.operational_booking_assignments",
        "pms.channel_booking_mappings",
        "pms.channel_booking_revision_tombstones",
        "pms.channel_rate_plan_mappings",
        "pms.channel_room_type_mappings",
        "pms.inventory_materialization_coverage",
        "pms.inventory_days",
        "pms.operating_calendar_room_bindings",
        "pms.operating_calendar_revisions",
        "pms.rate_plans",
        "pms.rooms",
        "pms.room_types",
        "booking.guest_bookings",
        "pms.channel_connections",
        "pms.channel_binding_claims",
        "hotel_catalog.property_locations",
      ])
        await client.query(`DELETE FROM ${table} WHERE property_id=$1`, [property]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await journalPool.end();
      await db.end();
    }
  });
  const revision = (status = "modified", checkout = "2026-09-04") => ({
    id: randomUUID(),
    attributes: {
      property_id: external,
      booking_id: providerBooking,
      status,
      ota_name: "Airbnb",
      arrival_date: "2026-09-01",
      departure_date: checkout,
      amount: "180.00",
      currency: "EUR",
      inserted_at: new Date(Date.UTC(2026, 7, 20, 12, 0, ++sequence)).toISOString(),
      rooms: [
        {
          room_type_id: providerRoom,
          rate_plan_id: "provider-rate",
          occupancy: { adults: 1, children: 0 },
          days: { "2026-09-01": "60", "2026-09-02": "60" },
        },
      ],
    },
  });
  async function queue(raw: ReturnType<typeof revision>) {
    return (
      await db.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,max_attempts,payload) VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,1,$3) RETURNING id`,
        [
          randomUUID(),
          providerBooking,
          {
            propertyId: property,
            providerPropertyId: external,
            channelBookingId: providerBooking,
            revision: raw.id,
            revisionSource: "revision_feed",
            pullRequired: false,
            rawPayload: { payload: raw },
          },
        ],
      )
    ).rows[0].id;
  }
  const run = (optIn = true, propertyIds = [property]) =>
    runChannexBookingJobs(url!, {
      apiBaseUrl: "https://app.channex.io",
      apiKey: "synthetic",
      ownsMutation: () => true,
      limit: 1,
      applyAirbnbAlterations: true,
      allowUnverifiedAirbnbAlterations: optIn,
      airbnbAlterationPropertyIds: propertyIds,
      fetch: async () => {
        acknowledgements++;
        return new Response(null, { status: 204 });
      },
    });
  it("preserves quarantined money through accepted alteration, rollback, replay and cancellation", async () => {
    await queue(revision("new", "2026-09-03"));
    expect(await run()).toMatchObject({ succeeded: 1 });
    // Another property's rollout does not change ordinary booking import behavior.
    await queue(revision("modified", "2026-09-03"));
    expect(await run(false, [randomUUID()])).toMatchObject({ succeeded: 1 });
    const booking = (
      await db.query("SELECT id FROM booking.guest_bookings WHERE property_id=$1", [property])
    ).rows[0].id;
    const binding = (
      await db.query("SELECT binding_generation FROM pms.channel_connections WHERE id=$1", [
        connection,
      ])
    ).rows[0].binding_generation;
    const request = randomUUID();
    await db.query(
      `INSERT INTO booking.booking_change_requests(id,guest_booking_id,request_type,requested_by,requested_changes) VALUES($1,$2,'date_change','guest',$3)`,
      [
        request,
        booking,
        {
          providerBookingId: providerBooking,
          oldCheckIn: "2026-09-01",
          oldCheckOut: "2026-09-03",
          requestedCheckIn: "2026-09-01",
          requestedCheckOut: "2026-09-04",
          oldTotal: "180.00",
          newTotal: null,
          oldAdults: 1,
          oldChildren: 0,
          currency: "EUR",
          rooms: [{ roomTypeId: providerRoom, adults: 1, children: 0 }],
          channex: {
            connectionId: connection,
            bindingGeneration: binding,
            providerPropertyId: external,
            eventId: randomUUID(),
            providerState: "pending",
          },
        },
      ],
    );
    const provider = {
      read: vi.fn(async () => ({ ok: true as const, state: "pending" as const })),
      resolve: vi.fn(async () => ({ ok: true as const, state: "accepted" as const })),
    };
    expect(
      await decideChannexAlteration(
        { pool: db, journalPool, provider, allowUnverifiedAirbnbAlterations: true },
        {
          propertyId: property,
          bookingId: booking,
          changeRequestId: request,
          actorUserId: randomUUID(),
          action: "accept",
          correlationId: "unverified-worker-connected",
        },
      ),
    ).toMatchObject({ providerState: "accepted", deliveryState: "resolved" });
    expect(provider.resolve).toHaveBeenCalledOnce();
    expect(
      (await db.query("SELECT check_out::text FROM booking.guest_bookings WHERE id=$1", [booking]))
        .rows[0].check_out,
    ).toBe("2026-09-03");
    const snapshot = async () =>
      (
        await db.query(
          `SELECT check_out::text, total_amount::text, balance_amount::text, booking_metadata, (SELECT count(*)::int FROM booking.nightly_revenue_evidence WHERE guest_booking_id=b.id) lines, (SELECT count(*)::int FROM finance.ota_commission_evidence WHERE guest_booking_id=b.id) commission_lines, (SELECT status FROM booking.booking_change_requests WHERE id=$2) request_status FROM booking.guest_bookings b WHERE id=$1`,
          [booking, request],
        )
      ).rows[0];
    const before = await snapshot();
    const paused = await queue(revision());
    expect(await run(true, [])).toMatchObject({ deadLettered: 1 });
    expect(acknowledgements).toBe(2);
    expect(
      (
        await db.query(
          "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
          [paused],
        )
      ).rows[0].code,
    ).toBe("alteration_runtime_disabled");
    expect(await snapshot()).toEqual(before);
    const disabled = await queue(revision());
    expect(await run(false)).toMatchObject({ deadLettered: 1 });
    expect(
      (
        await db.query(
          "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
          [disabled],
        )
      ).rows[0].code,
    ).toBe("alteration_finance_settings_required");
    expect(await snapshot()).toEqual(before);
    const payment = randomUUID();
    await db.query(
      "INSERT INTO finance.payments(id,property_id,guest_booking_id,payment_kind,status,amount,currency) VALUES($1,$2,$3,'deposit','pending',10,'EUR')",
      [payment, property, booking],
    );
    const protectedJob = await queue(revision());
    expect(await run()).toMatchObject({ deadLettered: 1 });
    expect(
      (
        await db.query(
          "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
          [protectedJob],
        )
      ).rows[0].code,
    ).toBe("alteration_finance_reconciliation_required");
    expect(await snapshot()).toEqual(before);
    await db.query("DELETE FROM finance.payments WHERE id=$1", [payment]);
    const trigger = `fail_${property.replaceAll("-", "")}`;
    await db.query(
      `CREATE FUNCTION pms.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.property_id='${property}'::uuid THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER ${trigger} BEFORE INSERT ON pms.channel_booking_mappings FOR EACH ROW EXECUTE FUNCTION pms.${trigger}()`,
    );
    try {
      const failed = await queue(revision());
      expect(await run()).toMatchObject({ deadLettered: 1 });
      expect(
        (
          await db.query(
            "SELECT job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1",
            [failed],
          )
        ).rows[0].code,
      ).toBe("write_unavailable");
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.query(
        `DROP TRIGGER ${trigger} ON pms.channel_booking_mappings; DROP FUNCTION pms.${trigger}()`,
      );
    }
    const changed = revision();
    changed.attributes.amount = "270.00";
    const job = await queue(changed);
    const result = await run();
    expect(
      result,
      JSON.stringify(
        (await db.query("SELECT job_metadata FROM platform.jobs WHERE id=$1", [job])).rows,
      ),
    ).toMatchObject({ succeeded: 1 });
    expect(await snapshot()).toMatchObject({
      check_out: "2026-09-04",
      total_amount: "180.00",
      balance_amount: "180.00",
      lines: 3,
      commission_lines: 3,
      booking_metadata: {
        airbnbMoneyStatus: "unverified",
        airbnbProviderAmount: { amount: "270.00", amountBasis: null },
      },
    });
    expect(
      (await db.query("SELECT status FROM booking.booking_change_requests WHERE id=$1", [request]))
        .rows[0].status,
    ).toBe("accepted");
    const applied = await snapshot();
    await queue(changed);
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect(await snapshot()).toEqual(applied);
    await queue(revision("cancelled"));
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect(
      (
        await db.query(
          "SELECT sum(occupied_room_nights)::int occupied,sum(gross_room_amount)::text gross FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [booking],
        )
      ).rows[0],
    ).toEqual({ occupied: 0, gross: null });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM finance.airbnb_provider_snapshots WHERE guest_booking_id=$1",
          [booking],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(acknowledgements).toBe(5);
  });
});
