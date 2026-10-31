import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { createTargetPmsOperationsReadRepository } from "../domains/pmsOperationsReadModel.js";
import { createTargetBookingReservationsReadRepository } from "../platform/bookingReservations.js";
import {
  createTargetBookingWebCheckoutAdapter,
  resolveTargetCheckoutProperty,
} from "./bookingWebPublic.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `11880000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = uuid(1);
const roomTypeId = uuid(2);
const addonId = uuid(5);
const occurredAt = new Date("2027-01-01T10:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)(
  "Booking Web canonical attribution PostgreSQL persistence",
  () => {
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
    const checkoutPool = new pg.Pool({
      connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
      max: 1,
    });

    beforeAll(async () => {
      const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
      if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
        throw new Error("Unsafe test database");
      }
      await cleanup();
      await seedProperty();
    });

    afterAll(async () => {
      await cleanup();
      await checkoutPool.end();
      await admin.end();
    });

    it("reads the committed same-day policy after waiting for its property lock", async () => {
      await admin.query(
        `INSERT INTO booking.same_day_booking_policies
           (property_id, enabled, cutoff_local_time)
         VALUES ($1::uuid, TRUE, '18:00')
         ON CONFLICT (property_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, cutoff_local_time = EXCLUDED.cutoff_local_time`,
        [propertyId],
      );
      const settings = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      const checkout = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      await settings.connect();
      await checkout.connect();
      try {
        await settings.query("BEGIN");
        await settings.query(
          `SELECT property.id FROM hotel_catalog.properties property
           WHERE property.id = $1::uuid FOR UPDATE OF property`,
          [propertyId],
        );
        await settings.query(
          `UPDATE booking.same_day_booking_policies SET enabled = FALSE
           WHERE property_id = $1::uuid`,
          [propertyId],
        );

        await checkout.query("BEGIN");
        const pid = await backendPid(checkout);
        const propertyRead = resolveTargetCheckoutProperty(
          checkout as never,
          "vay-1188-hotel",
          true,
        );
        await waitForLockWaiter(admin, pid);
        await settings.query("COMMIT");

        await expect(propertyRead).resolves.toMatchObject({ sameDayBookingsEnabled: false });
        await checkout.query("COMMIT");
      } finally {
        await settings.query("ROLLBACK").catch(() => undefined);
        await checkout.query("ROLLBACK").catch(() => undefined);
        await settings.end();
        await checkout.end();
      }
    });

    it("limits Find my booking in memory and stores nothing about the caller (VAY-2222)", async () => {
      const auditRows = async () =>
        (
          await admin.query<{ all: number; lookups: number }>(
            `SELECT count(*)::int AS all,
               count(*) FILTER (WHERE action = 'booking.guest_lookup.attempt')::int AS lookups
             FROM platform.product_audit_events`,
          )
        ).rows[0];
      const before = await auditRows();
      const app = buildApp({
        logger: false,
        // A fixed clock, so the six tries can't straddle the limit's one-minute window.
        bookingWebPublicNow: () => occurredAt,
        publicHotelProfileRepository: { findProfileBySlug: async () => null },
        bookingWebCheckoutAdapter: createAdapter(checkoutPool),
      });
      try {
        const statuses: number[] = [];
        for (let attempt = 1; attempt <= 6; attempt += 1)
          statuses.push(
            (
              await app.inject({
                method: "POST",
                url: "/api/booking-web/hotels/vay-1188-hotel/bookings/lookup",
                remoteAddress: "198.51.100.22",
                payload: {
                  bookingReference: `VAY-2222-${attempt}`,
                  guestEmail: "guest@example.test",
                },
              })
            ).statusCode,
          );
        expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
      } finally {
        await app.close();
      }
      expect(await auditRows()).toEqual(before);
    });

    it("returns the booked extras per extra with their days, and none for a booking without (VAY-2408, VAY-2409)", async () => {
      const breakfastId = uuid(6);
      await admin.query(
        `INSERT INTO booking.addon_definitions
         (id, property_id, name, pricing_model, price_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'Garden breakfast', 'per_night', 12, 'EUR')`,
        [breakfastId, propertyId],
      );
      for (const [id, reference] of [
        [uuid(7), "VAY-2408-EXTRAS"],
        [uuid(8), "VAY-2408-NONE"],
        [uuid(9), "VAY-2409-OLDER"],
      ] as const) {
        await admin.query(
          `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out,
            currency, total_amount, balance_amount, booking_metadata)
         VALUES ($1::uuid, $2::uuid, $3, 'confirmed', '2027-02-01', '2027-02-03',
                 'EUR', 300, 300, '{"paymentMethod":"pay_at_property"}')`,
          [id, propertyId, reference],
        );
        await admin.query(
          `INSERT INTO booking.booking_guests (guest_booking_id, guest_role, first_name, last_name, email)
         VALUES ($1::uuid, 'booker', 'Ada', 'Lovelace', 'guest@example.test')`,
          [id],
        );
      }
      // As checkout stores them: a per-night extra is one line per night, a per-guest one keeps its guests.
      await admin.query(
        `INSERT INTO booking.booking_addon_selections
         (property_id, guest_booking_id, addon_definition_id, addon_snapshot, quantity,
          service_date, total_amount, currency)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, '{"name":"Garden breakfast","selection":{"quantity":2,"people":null}}',
          2, '2027-02-02', 24, 'EUR'),
         ($1::uuid, $2::uuid, $3::uuid, '{"name":"Garden breakfast","selection":{"quantity":2,"people":null}}',
          2, '2027-02-01', 24, 'EUR'),
         ($1::uuid, $2::uuid, $4::uuid, '{"name":"Partner spa","selection":{"quantity":1,"people":[{"selectionId":"room","kind":"adult","index":0},{"selectionId":"room","kind":"adult","index":1}]}}',
          1, '2027-02-01', 20.5, 'EUR')`,
        [propertyId, uuid(7), breakfastId, addonId],
      );
      // VAY-2409: an older booking's lines of one extra with different quantities.
      await admin.query(
        `INSERT INTO booking.booking_addon_selections
         (property_id, guest_booking_id, addon_definition_id, addon_snapshot, quantity,
          service_date, total_amount, currency)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, '{"name":"Garden breakfast"}', 1, '2027-02-01', 12, 'EUR'),
         ($1::uuid, $2::uuid, $3::uuid, '{"name":"Garden breakfast"}', 2, '2027-02-02', 24, 'EUR')`,
        [propertyId, uuid(9), breakfastId],
      );
      const app = buildApp({
        logger: false,
        bookingWebPublicNow: () => occurredAt,
        publicHotelProfileRepository: { findProfileBySlug: async () => null },
        bookingWebCheckoutAdapter: createAdapter(checkoutPool),
      });
      try {
        const lookup = async (bookingReference: string) => {
          const response = await app.inject({
            method: "POST",
            url: "/api/booking-web/hotels/vay-1188-hotel/bookings/lookup",
            remoteAddress: "198.51.100.23",
            payload: { bookingReference, guestEmail: "guest@example.test" },
          });
          expect(response.statusCode).toBe(200);
          return response.json();
        };
        const booked = await lookup("VAY-2408-EXTRAS");
        // In checkout's order (the catalogue's, by add-on id), though all lines were written at once.
        // The partner spa's id is its source add-on id, as the PMS shows it.
        expect(booked.addonIds).toEqual(["spa_partner", breakfastId]);
        expect(booked.addonNames).toEqual(["Partner spa", "Garden breakfast"]);
        expect(booked.addonQuantities).toEqual({ [breakfastId]: 2, spa_partner: 2 });
        expect(booked.addonDates).toEqual({
          [breakfastId]: ["2027-02-01", "2027-02-02"],
          spa_partner: ["2027-02-01"],
        });
        expect(await lookup("VAY-2408-NONE")).toMatchObject({
          addonIds: [],
          addonNames: [],
          addonQuantities: {},
          addonDates: {},
        });
      } finally {
        await app.close();
      }
      // VAY-2409: the PMS reads the lines in checkout's order too, and Booking Admin's reservations
      // count the breakfast for 2 once, not once per night.
      const pms = await createTargetPmsOperationsReadRepository({
        connectionString: TEST_DATABASE_URL!,
        pool: admin as never,
      }).findReservationByGuestBookingId(propertyId, uuid(7));
      expect(pms?.addOns.map(({ addonId }) => addonId)).toEqual([
        "spa_partner",
        breakfastId,
        breakfastId,
      ]);
      const reservations = createTargetBookingReservationsReadRepository({
        connectionString: TEST_DATABASE_URL!,
        pool: admin as never,
      });
      const quantities = async (search: string) =>
        (
          await reservations.listReservationsByPropertyId(propertyId, {
            search,
            limit: 10,
            offset: 0,
            canReadGuestContact: false,
          })
        ).reservations.map(({ addonQuantities }) => addonQuantities);
      expect(await quantities("VAY-2408-EXTRAS")).toEqual([{ [breakfastId]: 2, spa_partner: 1 }]);
      // Lines that differ (older bookings) add up.
      expect(await quantities("VAY-2409-OLDER")).toEqual([{ [breakfastId]: 3 }]);
    });

    function createAdapter(pool: pg.Pool) {
      return createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: TEST_DATABASE_URL!,
        pool,
        inventoryReservationPort,
        billingConfigReadPortFactory: () => ({
          async getBillingConfig(requestedPropertyId) {
            return {
              propertyId: requestedPropertyId,
              activePlan: "commission",
              bookingEngineFeePercent: 5,
              channelManagerFeePercent: 8,
              affiliatePlatformFeePercent: 2,
              updatedAt: occurredAt.toISOString(),
            };
          },
        }),
      });
    }

    async function seedProperty(): Promise<void> {
      await admin.query(
        `INSERT INTO hotel_catalog.properties
         (id, public_id, display_name, profile_status, lifecycle_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'complete', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'canonical', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Europe/Athens')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug,
          default_locale, supported_locales, profile_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'vay-1188-hotel',
               'en', ARRAY['en'], 'complete')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO finance.payment_settings
         (property_id, payments_enabled, accepted_methods, default_currency)
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash'], 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.booking_settings
         (property_id, acceptance_mode, phone_required, default_currency)
       VALUES ($1::uuid, 'request', FALSE, 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.addon_definitions
         (id, property_id, source_addon_id, name, pricing_model, price_amount,
          currency, ownership_kind, partner_commission_rate)
       VALUES ($1::uuid, $2::uuid, 'spa_partner', 'Partner spa', 'per_guest', 10.25,
               'EUR', 'partner', 18.75)`,
        [addonId, propertyId],
      );
      await admin.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, finance_payment_settings_property_id, public_id, canonical_slug,
          canonical_url, booking_base_url, timezone, default_currency,
          supported_currencies, profile_status, freshness_status,
          capabilities, public_setup_completeness, data_sources)
       VALUES (
         $1::uuid, $1::uuid, 'vay-1188-hotel', 'vay-1188-hotel',
         'https://booking.example.test/vay-1188-hotel', 'https://booking.example.test',
         'Europe/Athens', 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"paymentMethods":["pay_at_property"]}'::jsonb, '{"status":"ready"}'::jsonb,
         ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']
       )`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO pms.room_types
         (id, property_id, name, occupancy_limits, base_rate_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'VAY-1188 Room', '{"adults":2,"total":2}', 100, 'EUR')`,
        [roomTypeId, propertyId],
      );
      // prettier-ignore
      await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO pms.operating_calendar_revisions (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at) VALUES (gen_random_uuid(),'${propertyId}',1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,1,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now()); INSERT INTO pms.operating_calendar_room_bindings (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) VALUES ('${propertyId}',1,'${roomTypeId}',1,1,2,2); COMMIT;`);
      await admin.query(
        `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
          inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
          generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $1::uuid,$2::uuid,stay_date,2,2,1,1,2,2,1,0,0,0,0
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
      await admin.query(
        `INSERT INTO distribution.public_room_offer_snapshots
         (property_id, room_type_id, stay_date, public_offer_key, available_rooms,
          base_price_amount, currency, payment_options, freshness_status)
       SELECT $1::uuid, $2::uuid, stay_date, 'vay-1188-flex', 2,
              100, 'EUR', ARRAY['pay_at_property'], 'fresh'
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
    }

    async function cleanup(): Promise<void> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "WITH s AS (DELETE FROM pms.inventory_reservation_statuses WHERE property_id=$1::uuid), w AS (DELETE FROM pms.inventory_reservation_day_watermarks WHERE property_id=$1::uuid), r AS (DELETE FROM pms.inventory_reservation_receipts WHERE property_id=$1::uuid) DELETE FROM platform.outbox_events WHERE property_id=$1::uuid",
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
          "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
          "DELETE FROM booking.direct_booking_summary_read_model WHERE property_id = $1::uuid",
          `DELETE FROM booking.booking_status_events
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          `DELETE FROM booking.booking_guests
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          "DELETE FROM booking.booking_addon_selections WHERE property_id = $1::uuid",
          "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
          "DELETE FROM booking.checkout_contexts WHERE property_id = $1::uuid",
          "DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid",
          "DELETE FROM booking.addon_definitions WHERE property_id = $1::uuid",
          "DELETE FROM booking.same_day_booking_policies WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
          "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
          "WITH b AS (DELETE FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid) DELETE FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid",
          "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
          "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
          "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
        ]) {
          await client.query(statement, [propertyId]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  },
);

const inventoryReservationPort = createTargetPmsInventoryReservationPort();

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function waitForLockWaiter(observer: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for checkout to acquire the property lock");
}
