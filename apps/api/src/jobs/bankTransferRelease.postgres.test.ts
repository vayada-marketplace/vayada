import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import {
  createPgBookingLifecycleStore,
  runBookingLifecycleSchedulerJobs,
} from "./bookingLifecycle.js";

const url = process.env.TEST_DATABASE_URL;

/** VAY-2348: an unpaid booking-page bank transfer is released at its 48-hour deadline. With the
 * real PMS hold and release, two sweeps at once (two servers) and a later one free the rooms
 * exactly once, write one expiry and tell guest and hotel once. */
describe.skipIf(!url)("bank transfer release with the real room hold (PostgreSQL)", () => {
  it("frees the held rooms exactly once when sweeps race and run again", async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("test database required");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const propertyId = randomUUID(),
      organizationId = randomUUID(),
      roomTypeId = randomUUID(),
      bookingId = randomUUID();
    const day = (offset: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };
    const nights = [day(30), day(31)];
    const [checkIn, checkOut] = [nights[0]!, day(32)];
    const deadline = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const stores = [0, 1].map(() =>
      createPgBookingLifecycleStore({
        connectionString: url!,
        max: 2,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      }),
    );
    const inventory = async () =>
      (
        await pool.query(
          `SELECT stay_date::text AS day, available_count AS available, assigned_count AS assigned
           FROM pms.inventory_days WHERE property_id=$1 ORDER BY stay_date`,
          [propertyId],
        )
      ).rows;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Bank release',($1::uuid)::text)",
        [organizationId],
      );
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Bank release')",
        [propertyId],
      );
      await db.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Berlin')",
        [propertyId],
      );
      await db.query(
        `INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,source_system,purpose)
         VALUES($1,'email','ops@release.example.test','platform','operations')`,
        [propertyId],
      );
      await db.query(
        `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits,base_rate_amount,currency)
         VALUES($1,$2,'Release room','{"adults":2,"children":1,"total":3}',100,'EUR')`,
        [roomTypeId, propertyId],
      );
      // As the inventory adoption suite: only the calendar's upstream audit rows bypass FKs.
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query(
        `INSERT INTO pms.operating_calendar_revisions
          (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
           property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
           idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
         VALUES($1,$2,1,'pms-operating-calendar.v1',1,'Europe/Berlin','year_round',0,1,1,
           gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
        [organizationId, propertyId],
      );
      await db.query(
        `INSERT INTO pms.operating_calendar_room_bindings
          (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,
           physical_capacity_count,starting_sellable_limit_count)
         VALUES($1,1,$2,1,1,3,3)`,
        [propertyId, roomTypeId],
      );
      await db.query("SET LOCAL session_replication_role=origin");
      await db.query(
        `INSERT INTO pms.inventory_days
          (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,inventory_revision,
           generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,
           channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
         SELECT $1,$2,day,3,3,1,1,3,3,1,0,0,0,0 FROM unnest($3::date[]) day`,
        [propertyId, roomTypeId, nights],
      );
      await db.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
          (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
         VALUES($1::uuid,($1::uuid)::text,'Bank release',($1::uuid)::text,'en',ARRAY['en'],'complete')`,
        [propertyId],
      );
      await db.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
          (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
           default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness)
         VALUES($1::uuid,($1::uuid)::text,($1::uuid)::text,'https://example.test','https://example.test',
           'Europe/Berlin','EUR',ARRAY['EUR'],'public','fresh','{"status":"ready"}')`,
        [propertyId],
      );
      await db.query(
        `INSERT INTO distribution.public_room_offer_snapshots
          (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,currency,
           payment_options,freshness_status,occupancy,rate_summary)
         SELECT property_id,room_type_id,stay_date,room_type_id::text,3,100,'EUR',ARRAY['bank_transfer'],
           'fresh','{"maxAdults":2,"maxChildren":1,"maxOccupancy":3}','{"minStayNights":1}'
         FROM pms.inventory_days WHERE property_id=$1`,
        [propertyId],
      );
      const bundle = await createTargetPmsInventoryReservationPort().reserveBundle!({
        propertyId,
        checkIn,
        checkOut,
        currency: "EUR",
        quoteSessionId: randomUUID(),
        occurredAt: new Date(),
        transaction: db,
        lines: [{ roomTypeId, publicOfferKey: roomTypeId, roomCount: 1 }],
      });
      await db.query(
        `INSERT INTO booking.guest_bookings
          (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
           check_in,check_out,adults,children,room_count,currency,total_amount,balance_amount,
           expected_payment_method,booking_metadata)
         VALUES($1::uuid,$2,$1::text,'booking',$1::text,'pending_payment','unpaid',$3,$4,2,0,1,'EUR',200,200,
           'bank_transfer',$5)`,
        [
          bookingId,
          propertyId,
          checkIn,
          checkOut,
          {
            targetSource: "pricing_quote_draft",
            paymentMethod: "bank_transfer",
            pendingExpiresAt: deadline,
            inventoryReservation: bundle,
          },
        ],
      );
      await db.query(
        `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email)
         VALUES($1,'booker','Bank','Guest','guest@release.example.test')`,
        [bookingId],
      );
      await db.query("COMMIT");
      // Held: one room fewer on both nights.
      expect(await inventory()).toEqual(
        nights.map((night) => ({ day: night, available: 2, assigned: 1 })),
      );

      const sweep = (store: (typeof stores)[number]) =>
        runBookingLifecycleSchedulerJobs(store, {
          now: new Date(Date.parse(deadline) + 1_000),
          run: ["pendingBookingExpiry"],
        });
      const mine = (results: Awaited<ReturnType<typeof sweep>>[]) => {
        const runs = results.flatMap((result) => result.runs);
        expect(
          runs.flatMap((run) => run.failures).filter((f) => f.guestBookingId === bookingId),
        ).toEqual([]);
        return runs
          .flatMap((run) => run.mutations)
          .filter((mutation) => mutation.guestBookingId === bookingId);
      };
      // Two servers sweep at the same moment: one expires it, the other finds nothing to do.
      const racing = mine(await Promise.all(stores.map(sweep)));
      expect(racing.filter((mutation) => mutation.applied)).toHaveLength(1);
      // A later sweep changes nothing.
      expect(mine([await sweep(stores[0]!)]).filter((mutation) => mutation.applied)).toEqual([]);

      expect(await inventory()).toEqual(
        nights.map((night) => ({ day: night, available: 3, assigned: 0 })),
      );
      const state = (
        await pool.query(
          `SELECT b.lifecycle_status AS status, b.cancellation_reason AS reason,
             (SELECT count(*)::int FROM booking.booking_status_events e
              WHERE e.guest_booking_id=b.id AND e.event_type='guest_booking.expired'
                AND e.actor_type='system') AS expiries,
             (SELECT array_agg(DISTINCT s.lifecycle_state) FROM pms.inventory_reservation_statuses s
              WHERE s.property_id=b.property_id) AS holds,
             (SELECT array_agg(j.job_type ORDER BY j.job_type) FROM platform.jobs j
              WHERE j.resource_id=b.id::text AND j.queue_name='platform.email') AS emails
           FROM booking.guest_bookings b WHERE b.id=$1`,
          [bookingId],
        )
      ).rows[0];
      expect(state).toEqual({
        status: "expired",
        reason: "pending_booking_expired",
        expiries: 1,
        holds: ["released"],
        emails: ["email.booking-expired", "email.booking-host-payment-expired"],
      });
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
      await Promise.all(stores.map((store) => store.close()));
      await db.query("BEGIN");
      await db.query("SET LOCAL session_replication_role=replica");
      await db.query(
        "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)",
        [propertyId],
      );
      const tables = (
        await db.query(
          `SELECT c.table_schema,c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t USING(table_schema,table_name)
           WHERE c.column_name='property_id' AND t.table_type='BASE TABLE'
             AND c.table_schema IN ('booking','distribution','finance','hotel_catalog','identity','platform','pms')`,
        )
      ).rows as { table_schema: string; table_name: string }[];
      await db.query("DELETE FROM booking.booking_guests WHERE guest_booking_id=$1", [bookingId]);
      await db.query("DELETE FROM booking.booking_status_events WHERE guest_booking_id=$1", [
        bookingId,
      ]);
      for (const { table_schema: schema, table_name: table } of tables)
        if (/^[a-z_]+$/.test(schema) && /^[a-z_]+$/.test(table))
          await db.query(`DELETE FROM "${schema}"."${table}" WHERE property_id::text=$1`, [
            propertyId,
          ]);
      await db.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await db.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      await db.query("COMMIT");
      db.release();
      await pool.end();
    }
  });
});
