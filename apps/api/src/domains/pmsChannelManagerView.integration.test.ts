import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readChannelManagerView } from "./pmsChannelManagerView.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
const P = "26061000-0000-4000-8000-000000000001";
const UNCONNECTED = "26061000-0000-4000-8000-000000000002";
const PROPERTIES = [P, UNCONNECTED];

describe.skipIf(!url)("Channel manager view (VAY-2606)", () => {
  const db = new pg.Pool({ connectionString: url });
  let connectionId = "";
  const rooms: Record<string, string> = {};

  async function clear() {
    const ids = `'${PROPERTIES.join("','")}'`;
    await db.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM pms.channel_operational_alerts WHERE property_id IN (${ids});
      DELETE FROM platform.jobs WHERE property_id IN (${ids});
      DELETE FROM pms.operational_booking_assignments WHERE property_id IN (${ids});
      DELETE FROM booking.guest_bookings WHERE property_id IN (${ids});
      DELETE FROM pms.channex_offer_target_versions WHERE target_id IN (SELECT id FROM pms.channex_offer_targets WHERE property_id IN (${ids}));
      DELETE FROM pms.channex_offer_target_intents WHERE target_id IN (SELECT id FROM pms.channex_offer_targets WHERE property_id IN (${ids}));
      DELETE FROM pms.channex_offer_targets WHERE property_id IN (${ids});
      DELETE FROM pms.channel_sync_status WHERE property_id IN (${ids});
      DELETE FROM pms.inventory_days WHERE property_id IN (${ids});
      DELETE FROM pms.channel_room_type_mappings WHERE property_id IN (${ids});
      DELETE FROM pms.room_types WHERE property_id IN (${ids});
      DELETE FROM pms.channel_connections WHERE property_id IN (${ids});
      DELETE FROM pms.channel_binding_claims WHERE property_id IN (${ids});
      DELETE FROM hotel_catalog.properties WHERE id IN (${ids});
      COMMIT`);
  }

  async function offer(
    room: string,
    offerId: string,
    configuration: Record<string, unknown>,
    sales: "open" | "closed",
    activate = true,
  ) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const target = (
        await client.query<{ id: string }>(
          "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4) RETURNING id::text",
          [P, connectionId, rooms[room], offerId],
        )
      ).rows[0]!.id;
      const intent = (
        await client.query<{ id: string }>(
          `INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal)
           VALUES($1,$2,'{"offerId":"vay2606"}') RETURNING id::text`,
          [target, `vay2606-${offerId}`],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO pms.channex_offer_target_versions(target_id,version,intent_id,binding_generation,
           external_property_id,external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
         SELECT $1,1,$2,binding_generation,external_property_id,$3,$4,$5::jsonb,'{"verified":true}'
         FROM pms.channel_connections WHERE id=$6`,
        [
          target,
          intent,
          `cx-${room}`,
          `cx-rate-${offerId}`,
          JSON.stringify(configuration),
          connectionId,
        ],
      );
      if (activate)
        await client.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [
          target,
        ]);
      await client.query("COMMIT");
      if (sales === "open")
        await db.query(
          "UPDATE pms.channex_offer_targets SET sales_state='open',sales_state_changed_at=now() WHERE id=$1",
          [target],
        );
      return target;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function nights(room: string, status: "open" | "closed", from: number, count: number) {
    const client = await db.connect();
    try {
      await client.query("BEGIN; SET LOCAL session_replication_role=replica");
      await client.query(
        `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count,status,calendar_revision,effective_sellable_limit_count,inventory_revision,generated_sellable_limit_count,generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
         SELECT $1,$2,current_date+day,2,CASE WHEN $3='closed' THEN 0 ELSE 2 END,$3,1,2,1,2,1,0,0,0,0
         FROM generate_series($4::int,$4::int+$5::int-1) day`,
        [P, rooms[room], status, from, count],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function pull(status: "succeeded" | "failed", minutesAgo: number) {
    await db.query(
      `INSERT INTO platform.jobs(job_key,queue_name,job_type,status,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,finished_at)
       VALUES($1,'pms.channex.webhooks','channex.pull-booking-feed',$2,'property',$3,'pms','channel_connection',$4,'{}'::jsonb,now()-($5::int*interval '1 minute'))`,
      [`vay2606-pull-${status}-${minutesAgo}`, status, P, connectionId, minutesAgo],
    );
  }

  beforeAll(async () => {
    await clear();
    for (const [id, name] of [
      [P, "Alpenrose test"],
      [UNCONNECTED, "Not connected test"],
    ])
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,$3)",
        [id, `vay2606-${id.slice(-1)}`, name],
      );
    await db.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex','provider-2606','active','repair')`,
      [P],
    );
    connectionId = (
      await db.query<{ id: string }>(
        `INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status)
         VALUES($1,'channex','provider-2606','connected') RETURNING id::text`,
        [P],
      )
    ).rows[0]!.id;
    for (const [key, name, sort] of [
      ["garden", "Garden Room", 1],
      ["loft", "Lake Loft", 2],
      ["suite", "Alpine Suite", 0],
      ["unsold", "Unsold Room", 3],
    ] as const) {
      rooms[key] = (
        await db.query<{ id: string }>(
          `INSERT INTO pms.room_types(property_id,name,currency,base_rate_amount,sort_order)
           VALUES($1,$2,'EUR',100,$3) RETURNING id::text`,
          [P, name, sort],
        )
      ).rows[0]!.id;
      await db.query(
        `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id)
         VALUES($1,$2,$3,$4)`,
        [P, connectionId, rooms[key], `cx-${key}`],
      );
    }
    const roomOnly = (max: number) => ({
      sell_mode: "per_person",
      meal_type: "room_only",
      options: Array.from({ length: max }, (_, index) => ({
        occupancy: index + 1,
        is_primary: index + 1 === max,
      })),
    });
    await offer("garden", "garden-flex", roomOnly(2), "open");
    await offer("loft", "loft-flex", roomOnly(4), "open");
    await offer("suite", "suite-breakfast", { ...roomOnly(2), meal_type: "breakfast" }, "closed");
    // Never activated: Booking.com and Airbnb don't sell it.
    await offer("unsold", "unsold-flex", roomOnly(2), "open", false);
    await nights("garden", "open", 1, 5);
    await nights("suite", "open", 1, 5);
    // The loft's only nights are closed, or more than a year away.
    await nights("loft", "closed", 1, 5);
    await nights("loft", "open", 400, 3);
  });

  afterAll(async () => {
    await clear();
    await db.end();
  });

  it("shows the offers Booking.com and Airbnb sell, and why one isn't selling", async () => {
    const view = await readChannelManagerView(db, P);
    expect(view.connection).toEqual({ status: "connected" });
    expect(view.channels).toEqual({ status: "unavailable" });
    expect(
      view.rooms.map(({ roomTypeName, mealPlan, maxGuests, selling, notSellingReason }) => ({
        roomTypeName,
        mealPlan,
        maxGuests,
        selling,
        notSellingReason,
      })),
    ).toEqual([
      {
        roomTypeName: "Alpine Suite",
        mealPlan: "breakfast",
        maxGuests: 2,
        selling: false,
        notSellingReason: "sales_closed",
      },
      {
        roomTypeName: "Garden Room",
        mealPlan: "room_only",
        maxGuests: 2,
        selling: true,
        notSellingReason: null,
      },
      {
        roomTypeName: "Lake Loft",
        mealPlan: "room_only",
        maxGuests: 4,
        selling: false,
        notSellingReason: "no_open_nights",
      },
    ]);
  });

  it("reads the price sync, the booking pull's own runs and the newest booking without guest details", async () => {
    expect((await readChannelManagerView(db, P)).sync).toEqual({
      prices: { status: "never", lastSuccessAt: null, retryAt: null },
      bookings: { status: "never", lastCheckedAt: null, latest: null },
    });

    await db.query(
      `INSERT INTO pms.channel_sync_status(property_id,connection_id,sync_domain,status,last_success_at,retry_after)
       VALUES($1,$2,'ari','failed',now()-interval '20 minutes',now()+interval '10 minutes')`,
      [P, connectionId],
    );
    await pull("succeeded", 15);
    await pull("failed", 5);
    for (const [reference, channel, checkIn, ageMinutes] of [
      ["older", "airbnb", "2026-12-01", 60],
      ["newer", "booking_com", "2026-12-12", 30],
    ] as const) {
      const booking = (
        await db.query<{ id: string }>(
          `INSERT INTO booking.guest_bookings(property_id,public_reference,source_system,source_booking_id,
             lifecycle_status,payment_status,check_in,check_out,adults,children,room_count,currency,
             total_amount,balance_amount,booking_channel,booking_metadata,created_at)
           VALUES($1,$2,'pms',$3,'confirmed','unpaid',$4::date,$4::date+2,2,0,1,'EUR',200,200,$5,
             '{"provider":"channex"}'::jsonb,now()-($6::int*interval '1 minute')) RETURNING id::text`,
          [
            P,
            `CHX-VAY2606-${reference}`,
            `channex:${P}:${reference}`,
            checkIn,
            channel,
            ageMinutes,
          ],
        )
      ).rows[0]!.id;
      await db.query(
        `INSERT INTO pms.operational_booking_assignments
           (property_id, guest_booking_id, room_type_id, position, assignment_status, source, stay_evidence_kind)
         VALUES ($1, $2, $3, 1, 'pending', 'migration', 'summary_only')`,
        [P, booking, rooms.garden],
      );
    }

    const { sync } = await readChannelManagerView(db, P);
    expect(sync.prices).toMatchObject({ status: "retrying", retryAt: expect.any(String) });
    expect(sync.prices.lastSuccessAt).not.toBeNull();
    expect(sync.bookings).toEqual({
      status: "retrying",
      lastCheckedAt: expect.any(String),
      latest: {
        channel: "booking_com",
        roomTypeName: "Garden Room",
        checkIn: "2026-12-12",
        checkOut: "2026-12-14",
      },
    });

    await pull("succeeded", 1);
    expect((await readChannelManagerView(db, P)).sync.bookings.status).toBe("ok");

    // A good run that left some rooms' offers behind (VAY-2108 D3) isn't "nothing goes out".
    await db.query(
      `UPDATE pms.channel_sync_status SET status='degraded',retry_after=NULL,last_error_code='offer_targets_skipped'
       WHERE property_id=$1 AND sync_domain='ari'`,
      [P],
    );
    expect((await readChannelManagerView(db, P)).sync.prices.status).toBe("partial");

    // Half an hour without a good pull: the booking check isn't working.
    await db.query(
      "UPDATE platform.jobs SET finished_at=finished_at-interval '1 hour' WHERE property_id=$1",
      [P],
    );
    expect((await readChannelManagerView(db, P)).sync.bookings).toMatchObject({
      status: "failed",
      lastCheckedAt: expect.any(String),
    });
  });

  it("lists open problems with the hotel's own room name, and leaves closed ones out", async () => {
    const insert = (
      eventType: string,
      impact: Record<string, unknown>,
      resolved: boolean,
      seenDaysAgo: number | null = null,
    ) =>
      db.query(
        `INSERT INTO pms.channel_operational_alerts(property_id,connection_id,binding_generation,problem_key,event_type,impact,first_occurred_at,last_occurred_at,resolved_at,acknowledged_at)
         SELECT $1,id,binding_generation,$2,$3,$4::jsonb,
           now()-COALESCE($7::int,0)*interval '1 day'-interval '1 hour',now()-COALESCE($7::int,0)*interval '1 day',
           CASE WHEN $5 THEN now() END,CASE WHEN $7::int IS NOT NULL THEN now()-$7::int*interval '1 day' END
         FROM pms.channel_connections WHERE id=$6`,
        [
          P,
          `vay2606-${eventType}-${resolved}-${seenDaysAgo}`,
          eventType,
          JSON.stringify(impact),
          resolved,
          connectionId,
          seenDaysAgo,
        ],
      );
    await insert(
      "booking_not_imported",
      {
        channel: "Airbnb",
        roomTypeId: "cx-garden",
        dateFrom: "2027-03-05",
        dateTo: "2027-03-07",
        reference: "HMVAY2606",
        errorType: "operational_inventory_unavailable",
      },
      false,
    );
    await insert("sync_error", { channel: "BookingCom" }, true);
    // Seen, and quiet for more than a week: off the page. Seen yesterday: still listed.
    await insert("sync_warning", { channel: "BookingCom" }, false, 8);
    await insert("rate_error", { channel: "AirBNB" }, false, 1);

    const { problems } = await readChannelManagerView(db, P);
    expect(problems).toEqual([
      {
        id: expect.any(String),
        eventType: "booking_not_imported",
        channel: "Airbnb",
        roomTypeName: "Garden Room",
        dateFrom: "2027-03-05",
        dateTo: "2027-03-07",
        reference: "HMVAY2606",
        errorType: "operational_inventory_unavailable",
        firstOccurredAt: expect.any(String),
        acknowledgedAt: null,
      },
      expect.objectContaining({
        eventType: "rate_error",
        channel: "AirBNB",
        acknowledgedAt: expect.any(String),
      }),
    ]);
  });

  it("shows a hotel without a Channex connection as not connected, with nothing else", async () => {
    expect(await readChannelManagerView(db, UNCONNECTED)).toEqual({
      contractVersion: "pms-channel-manager-view.v1",
      propertyId: UNCONNECTED,
      connection: { status: "disconnected" },
      channels: { status: "unavailable" },
      rooms: [],
      sync: {
        prices: { status: "never", lastSuccessAt: null, retryAt: null },
        bookings: { status: "never", lastCheckedAt: null, latest: null },
      },
      problems: [],
    });
  });
});
