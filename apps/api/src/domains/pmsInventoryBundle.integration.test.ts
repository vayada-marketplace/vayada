import { findTargetRoomCombinationOffers } from "../routes/bookingRoomCombinationOffers.js";
import { loadTargetCheckoutOffer } from "../routes/bookingWebPublic.js";
import { quoteTargetRoomSelection } from "../routes/bookingWebMixedQuote.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import type { PmsInventoryReservationBundle } from "@vayada/domain-pms";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("mixed room inventory transactions", () => {
  const pool = new pg.Pool({ connectionString: url });
  const propertyId = randomUUID();
  const rooms = [randomUUID(), randomUUID()].sort();
  const port = createTargetPmsInventoryReservationPort();
  const input = {
    propertyId,
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    currency: "EUR",
    occurredAt: new Date("2027-01-01T10:00:00Z"),
    lines: rooms.map((roomTypeId) => ({ roomTypeId, publicOfferKey: roomTypeId, roomCount: 2 })),
  };
  async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const reserve = () =>
    transaction((client) =>
      port.reserveBundle!({
        ...input,
        quoteSessionId: randomUUID(),
        transaction: client,
      }),
    );
  const release = (reservation: PmsInventoryReservationBundle) =>
    transaction((client) => port.release({ ...input, transaction: client, reservation }));
  async function inventory() {
    return (
      await pool.query(
        `SELECT available_count FROM pms.inventory_days
      WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
        [propertyId],
      )
    ).rows.map((row) => row.available_count);
  }
  beforeAll(async () => {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
        VALUES ($1::uuid,$1::text,'Mixed room test')`,
        [propertyId],
      );
      await client.query(
        "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose,status) VALUES($1::uuid,$1::text,'canonical','active')",
        [propertyId],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
        VALUES ($1::uuid,$1::text,'Mixed room test',$1::text,'en',ARRAY['en'],'complete')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
        (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
         default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness)
        VALUES ($1::uuid,$1::text,$1::text,'https://example.test','https://example.test','Europe/Athens','EUR',ARRAY['EUR'],
          'public','fresh','{"status":"ready"}')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types (id,property_id,name,occupancy_limits,base_rate_amount,currency)
        SELECT id,$1,id::text,'{"adults":2,"total":2}',100,'EUR' FROM unnest($2::uuid[]) id`,
        [propertyId, rooms],
      );
      await client.query(
        `INSERT INTO booking.booking_settings(property_id,acceptance_mode,default_currency,phone_required)
        VALUES ($1,'request','EUR',false)`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
        VALUES ($1,true,ARRAY['pay_at_property','cash'],'EUR')`,
        [propertyId],
      );
      await client.query(
        `UPDATE distribution.public_hotel_bookability_profiles SET capabilities='{"paymentMethods":["pay_at_property"]}' WHERE property_id=$1`,
        [propertyId],
      );
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        `INSERT INTO pms.operating_calendar_revisions
        (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
         property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
         idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
        VALUES (gen_random_uuid(),$1,1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,2,1,
          gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.operating_calendar_room_bindings
        (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,
         physical_capacity_count,starting_sellable_limit_count)
        SELECT $1,1,id,1,1,2,2 FROM unnest($2::uuid[]) id`,
        [propertyId, rooms],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      await client.query(
        `INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,inventory_revision,
         generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,
         channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
        SELECT $1,id,day,2,2,1,1,2,2,1,0,0,0,0 FROM unnest($2::uuid[]) id,
          unnest(ARRAY[DATE '2027-02-01',DATE '2027-02-02']) day`,
        [propertyId, rooms],
      );
      await client.query(
        `INSERT INTO distribution.public_room_offer_snapshots
        (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,
         currency,payment_options,freshness_status,occupancy,rate_summary)
        SELECT property_id,room_type_id,stay_date,room_type_id::text,2,100,'EUR',ARRAY['pay_at_property'],'fresh','{"maxAdults":2,"maxChildren":1,"maxOccupancy":2}','{"minStayNights":1}'
        FROM pms.inventory_days WHERE property_id=$1`,
        [propertyId],
      );
    });
  });
  afterAll(async () => {
    await transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role=replica");
      for (const table of ["booking.booking_guests", "booking.booking_status_events"])
        await client.query(
          `DELETE FROM ${table} WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id=$1)`,
          [propertyId],
        );
      for (const table of [
        "platform.jobs",
        "platform.product_audit_events",
        "booking.booking_addon_selections",
        "booking.direct_booking_summary_read_model",
        "booking.guest_bookings",
        "booking.checkout_contexts",
        "booking.promo_applications",
        "booking.promo_definitions",
        "booking.quote_sessions",
        "booking.addon_definitions",
        "booking.booking_settings",
        "finance.payment_settings",
        "pms.inventory_reservation_statuses",
        "pms.inventory_reservation_day_watermarks",
        "pms.inventory_reservation_receipts",
        "platform.outbox_events",
        "platform.domain_events",
        "platform.idempotency_keys",
        "distribution.public_room_offer_snapshots",
        "pms.inventory_days",
        "pms.operating_calendar_room_bindings",
        "pms.operating_calendar_revisions",
        "pms.room_types",
        "pms.rate_rules",
        "pms.linked_inventory_groups",
        "pms.room_blocks",
        "distribution.public_hotel_bookability_profiles",
        "hotel_catalog.property_public_profile_read_model",
        "hotel_catalog.property_slugs",
      ])
        await client.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    });
    await pool.end();
  });
  const selection = {
    contractVersion: "booking-room-selection.v1",
    lines: [
      {
        roomTypeId: rooms[0]!,
        publicOfferKey: rooms[0]!,
        guests: [
          { adults: 2, children: 0 },
          { adults: 1, children: 1 },
        ],
      },
      { roomTypeId: rooms[1]!, publicOfferKey: rooms[1]!, guests: [{ adults: 2, children: 0 }] },
    ],
  };
  const quote = () =>
    quoteTargetRoomSelection(pool, {
      ...input,
      selection,
      today: "2027-01-01",
      requestedAt: input.occurredAt,
    });
  const search = (adults = 5, children = 1, maxCandidates?: number) =>
    findTargetRoomCombinationOffers(pool, {
      ...input,
      adults,
      children,
      today: "2027-01-01",
      requestedAt: input.occurredAt,
      paymentMethods: ["pay_at_property"],
      maxCandidates,
    });
  it.each([
    [
      "available_rooms=0, availability_status='sold_out', sellable_publicly=false",
      "sold_out",
      true,
    ],
    ["expires_at='2026-12-31'", "stale_data", false],
    ["rate_summary='{\"minStayNights\":3}'", "min_stay_not_met", true],
    ["rate_summary='{\"maxStayNights\":1}'", "max_stay_exceeded", true],
    ['rate_summary=\'{"minStayNights":"unknown"}\'', "unavailable_data", false],
  ] as const)("preserves availability reasons for %s", async (update, code, complete) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE distribution.public_room_offer_snapshots SET ${update} WHERE property_id=$1`,
        [propertyId],
      );
      expect(
        await findTargetRoomCombinationOffers(client, {
          ...input,
          adults: 5,
          children: 1,
          today: "2027-01-01",
          requestedAt: input.occurredAt,
          paymentMethods: ["pay_at_property"],
        }),
      ).toMatchObject({ complete, options: [], unavailableReasons: [{ code }] });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  // Retired v1 quote path: the payment_disabled row prices the selection through the VAY-1546
  // stub. v2 pricing is covered by the replacementPricing* suites.
  it.todo("preserves availability reasons for payment_options=ARRAY['card']");
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip("distinguishes incompatible methods across otherwise sufficient room types", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE distribution.public_room_offer_snapshots SET payment_options=ARRAY['card'] WHERE property_id=$1 AND room_type_id=$2",
        [propertyId, rooms[0]],
      );
      expect(
        await findTargetRoomCombinationOffers(client, {
          ...input,
          adults: 5,
          children: 1,
          today: "2027-01-01",
          requestedAt: input.occurredAt,
          paymentMethods: ["card", "pay_at_property"],
        }),
      ).toMatchObject({
        complete: true,
        options: [],
        unavailableReasons: [{ code: "payment_disabled" }],
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip.each([
    ["min_stay_nights", 3, "min_stay_not_met"],
    ["max_stay_nights", 1, "max_stay_exceeded"],
  ] as const)("preserves canonical PMS %s restrictions", async (column, value, code) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,${column}) VALUES($1,$2,'stay_restriction',$3,$3,$4)`,
        [propertyId, rooms[0], input.checkIn, value],
      );
      expect(
        await findTargetRoomCombinationOffers(client, {
          ...input,
          adults: 5,
          children: 1,
          today: "2027-01-01",
          requestedAt: input.occurredAt,
          paymentMethods: ["pay_at_property"],
        }),
      ).toMatchObject({ complete: true, options: [], unavailableReasons: [{ code }] });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip.each([
    ["2027-02-02", true, "stay_restricted"],
    ["2027-02-02", false, null],
    ["2027-02-03", true, null],
  ] as const)("evaluates canonical stop-sell on %s (enabled=%s)", async (day, enabled, reason) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,stop_sell,enabled)
        VALUES($1,$2,'stay_restriction',$3,$3,true,$4)`,
        [propertyId, rooms[0], day, enabled],
      );
      const result = await findTargetRoomCombinationOffers(client, {
        ...input,
        adults: 5,
        children: 1,
        today: "2027-01-01",
        requestedAt: input.occurredAt,
        paymentMethods: ["pay_at_property"],
      });
      if (reason)
        expect(result).toMatchObject({
          complete: true,
          options: [],
          unavailableReasons: [{ code: reason }],
        });
      else expect(result.options.length).toBeGreaterThan(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip("uses the minimum occupancy over every night and requires every explicit bound", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE distribution.public_room_offer_snapshots SET occupancy=jsonb_set(occupancy,'{maxAdults}','1') WHERE property_id=$1 AND stay_date='2027-02-02'",
        [propertyId],
      );
      const run = () =>
        findTargetRoomCombinationOffers(client, {
          ...input,
          adults: 5,
          children: 0,
          today: "2027-01-01",
          requestedAt: input.occurredAt,
          paymentMethods: ["pay_at_property"],
        });
      expect(await run()).toMatchObject({ complete: true, eligibleOfferCount: 2, options: [] });
      await client.query(
        "UPDATE distribution.public_room_offer_snapshots SET occupancy=occupancy-'maxChildren' WHERE property_id=$1",
        [propertyId],
      );
      expect(await run()).toMatchObject({ complete: false, eligibleOfferCount: 0, options: [] });
      for (const bound of ['"unknown"', "99999999999999999999999999999"]) {
        await client.query(
          "UPDATE distribution.public_room_offer_snapshots SET occupancy=jsonb_set(occupancy,'{maxChildren}',$2::jsonb) WHERE property_id=$1",
          [propertyId, bound],
        );
        expect(await run()).toMatchObject({ complete: false, eligibleOfferCount: 0, options: [] });
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("credits complete reserved bundles without assuming receipt order or an original quote UUID", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reservation = await port.reserveBundle!({
        ...input,
        transaction: client,
        quoteSessionId: `change-request:${randomUUID()}`,
      });
      expect(
        (
          await client.query(
            `SELECT payload->>'roomTypeId' AS room,payload->>'reason' AS reason
             FROM platform.outbox_events
             WHERE property_id=$1 AND destination='pms.channel-manager'
               AND event_type='pms.inventory.ari_changed'
             ORDER BY room,reason`,
            [propertyId],
          )
        ).rows,
      ).toEqual(rooms.map((room) => ({ room, reason: "reservation_held" })));
      const base = {
        ...input,
        transaction: client,
        reservation: { ...reservation, receipts: [...reservation.receipts].reverse() },
      };
      expect(await port.bundleAvailabilityCredits!(base)).toEqual(
        new Map(
          rooms.map((id) => [
            id,
            { checkIn: input.checkIn, checkOut: input.checkOut, roomCount: 2 },
          ]),
        ),
      );
      expect(
        await port.bundleAvailabilityCredits!({ ...base, propertyId: randomUUID() }),
      ).toBeNull();
      expect(await port.bundleAvailabilityCredits!({ ...base, checkOut: "2027-02-04" })).toBeNull();
      expect(
        await port.bundleAvailabilityCredits!({
          ...base,
          lines: input.lines.map((line) => ({ ...line, roomCount: 1 })),
        }),
      ).toBeNull();
      expect(
        await port.bundleAvailabilityCredits!({
          ...base,
          lines: [input.lines[0]!],
          reservation: { ...reservation, receipts: [reservation.receipts[0]!] },
        }),
      ).toBeNull();
      await client.query("SAVEPOINT duplicate_type");
      // Corrupt only this transaction's synthetic receipt to exercise a shape the normal bundle writer forbids.
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        "UPDATE pms.inventory_reservation_receipts SET room_type_id=$2::text::uuid,public_offer_key=$2::text WHERE receipt_id=$1",
        [reservation.receipts[1]!.receiptId, rooms[0]],
      );
      expect(await port.bundleAvailabilityCredits!(base)).toBeNull();
      await client.query("ROLLBACK TO SAVEPOINT duplicate_type");
      await port.release({ ...input, transaction: client, reservation });
      expect(
        (
          await client.query(
            `SELECT payload->>'roomTypeId' AS room,payload->>'reason' AS reason
             FROM platform.outbox_events
             WHERE property_id=$1 AND destination='pms.channel-manager'
               AND event_type='pms.inventory.ari_changed'
             ORDER BY room,reason`,
            [propertyId],
          )
        ).rows,
      ).toEqual(
        rooms.flatMap((room) => [
          { room, reason: "reservation_held" },
          { room, reason: "reservation_released" },
        ]),
      );
      expect(await port.bundleAvailabilityCredits!(base)).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip("quotes six guests using actual per-room caps and exact full-stay combined prices", async () => {
    await pool.query(
      "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=100.01 WHERE property_id=$1",
      [propertyId],
    );
    try {
      const result = await quote();
      expect(result.party).toEqual({ adults: 5, children: 1, rooms: 3 });
      expect(result.totals.totalAmount).toBe("600.06");
      expect(result.lines.map((line) => line.totals.roomTotal)).toEqual(["400.04", "200.02"]);
      expect(result.paymentOptions).toEqual(["pay_at_property"]);
    } finally {
      await pool.query(
        "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=100 WHERE property_id=$1",
        [propertyId],
      );
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip.each([
    [
      "occupancy='{}'::jsonb",
      'occupancy=\'{"maxAdults":2,"maxChildren":1,"maxOccupancy":2}\'::jsonb',
    ],
    ["available_rooms=0", "available_rooms=2"],
    ["freshness_status='stale'", "freshness_status='fresh'"],
    ["payment_options=ARRAY['card']", "payment_options=ARRAY['pay_at_property']"],
  ])("rejects invalid per-night evidence (%s)", async (change, restore) => {
    await pool.query(
      `UPDATE distribution.public_room_offer_snapshots SET ${change} WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2027-02-01'`,
      [propertyId, rooms[0]],
    );
    try {
      await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
      const code = change.startsWith("occupancy=")
        ? "unavailable_data"
        : change.startsWith("freshness_status=")
          ? "stale_data"
          : change.startsWith("available_rooms=")
            ? "sold_out"
            : change.startsWith("rate_summary=")
              ? "min_stay_not_met"
              : "payment_disabled";
      expect(await search()).toMatchObject({
        complete: !["unavailable_data", "stale_data"].includes(code),
        options: [],
        unavailableReasons: [{ code }],
      });
    } finally {
      await pool.query(
        `UPDATE distribution.public_room_offer_snapshots SET ${restore} WHERE property_id=$1 AND room_type_id=$2`,
        [propertyId, rooms[0]],
      );
    }
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip.each(["closed_to_arrival", "closed_to_departure"])(
    "checks %s on the boundary date",
    async (column) => {
      const date = column === "closed_to_arrival" ? input.checkIn : input.checkOut;
      await pool.query(
        `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,${column})
      VALUES($1,$2,'arrival_departure_restriction',$3,$3,true)`,
        [propertyId, rooms[0], date],
      );
      try {
        await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
        expect(await search()).toMatchObject({
          complete: true,
          options: [],
          unavailableReasons: [{ code: "stay_restricted" }],
        });
      } finally {
        await pool.query("DELETE FROM pms.rate_rules WHERE property_id=$1", [propertyId]);
      }
    },
  );
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip("prefers canonical flexible price and meals without changing exact-offer selection", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const ratePlanId = randomUUID();
      const key = `${rooms[0]}:onb15-flex-${ratePlanId}`;
      await client.query(
        `INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency)
        VALUES($1,$2,$3,$4,'Flexible','flexible',120,'EUR')`,
        [ratePlanId, propertyId, rooms[0], `ONB15-FLEX-${ratePlanId}`],
      );
      await client.query(
        `UPDATE distribution.public_room_offer_snapshots
        SET rate_summary='{"refundable":true}' WHERE property_id=$1 AND room_type_id=$2`,
        [propertyId, rooms[0]],
      );
      await client.query(
        `INSERT INTO distribution.public_room_offer_snapshots
        (property_id,room_type_id,rate_plan_id,stay_date,public_offer_key,available_rooms,base_price_amount,
         currency,payment_options,freshness_status,occupancy,rate_summary)
        SELECT property_id,room_type_id,$3,stay_date,$4,2,120,'EUR',payment_options,'fresh',occupancy,
          '{"refundable":true,"mealPlan":"breakfast"}'
        FROM distribution.public_room_offer_snapshots WHERE property_id=$1 AND room_type_id=$2`,
        [propertyId, rooms[0], ratePlanId, key],
      );
      const request = {
        ...input,
        adults: 1,
        children: 0,
        roomCount: 1,
        nights: 2,
        roomTypeId: rooms[0]!,
        rateType: "flexible",
        requestedAt: input.occurredAt,
      };
      expect(await loadTargetCheckoutOffer(client, request)).toMatchObject({
        publicOfferKey: key,
        roomTotal: "240.00",
        rateSummary: { mealPlan: "breakfast" },
      });
      expect(
        await loadTargetCheckoutOffer(client, { ...request, exactPublicOfferKey: rooms[0]! }),
      ).toMatchObject({ publicOfferKey: rooms[0], roomTotal: "200.00" });
      expect(
        await loadTargetCheckoutOffer(client, {
          ...request,
          availabilityCredit: { checkIn: input.checkIn, checkOut: input.checkOut, roomCount: 1 },
        }),
      ).toMatchObject({ publicOfferKey: rooms[0], roomTotal: "200.00" });
      expect(
        await loadTargetCheckoutOffer(client, { ...request, rateType: ratePlanId }),
      ).toMatchObject({ publicOfferKey: key });
      await client.query(
        `UPDATE distribution.public_room_offer_snapshots SET sellable_publicly=false
        WHERE property_id=$1 AND public_offer_key=$2`,
        [propertyId, key],
      );
      expect(await loadTargetCheckoutOffer(client, request)).toMatchObject({
        publicOfferKey: rooms[0],
        roomTotal: "200.00",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip.each([
    "min_stay_nights",
    "max_stay_nights",
    "closed_to_arrival",
    "closed_to_departure",
    "stop_sell",
  ])("ordinary checkout and atomic single-room reservation enforce %s", async (column) => {
    const date = column === "closed_to_departure" ? input.checkOut : input.checkIn;
    const value = column === "min_stay_nights" ? 3 : column === "max_stay_nights" ? 1 : true;
    await pool.query(
      `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,${column})
        VALUES($1,$2,'stay_restriction',$3,$3,$4)`,
      [propertyId, rooms[0], date, value],
    );
    const offerInput = {
      ...input,
      adults: 1,
      children: 0,
      roomCount: 1,
      nights: 2,
      roomTypeId: rooms[0]!,
      rateType: "",
      requestedAt: input.occurredAt,
    };
    try {
      await expect(loadTargetCheckoutOffer(pool, offerInput)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(
        await transaction((client) =>
          port.reserve({
            ...input,
            transaction: client,
            quoteSessionId: randomUUID(),
            roomTypeId: rooms[0]!,
            publicOfferKey: rooms[0]!,
            roomCount: 1,
          }),
        ),
      ).toBeNull();
      expect(await inventory()).toEqual([2, 2, 2, 2]);
    } finally {
      await pool.query("DELETE FROM pms.rate_rules WHERE property_id=$1", [propertyId]);
    }
    expect(await loadTargetCheckoutOffer(pool, offerInput)).toMatchObject({ roomTypeId: rooms[0] });
  });

  it("rolls back earlier room holds when a later room fails", async () => {
    await expect(
      transaction((client) =>
        port.reserveBundle!({
          ...input,
          transaction: client,
          quoteSessionId: randomUUID(),
          lines: [input.lines[0]!, { ...input.lines[1]!, roomCount: 3 }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([2, 2, 2, 2]);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM pms.inventory_reservation_receipts WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("has one winner for simultaneous last-combination buyers and releases every hold once", async () => {
    const outcomes = await Promise.allSettled([reserve(), reserve()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing winner");
    expect(await inventory()).toEqual([0, 0, 0, 0]);
    await expect(
      release({ ...winner.value, receipts: winner.value.receipts.slice(0, 1) }),
    ).rejects.toThrow("scope mismatch");
    expect(await inventory()).toEqual([0, 0, 0, 0]);
    await release(winner.value);
    await release(winner.value);
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
  it("replays the complete selection and rejects quote reuse before consuming stock", async () => {
    const quoteSessionId = randomUUID();
    const reserveLines = (lines: typeof input.lines) =>
      transaction((client) =>
        port.reserveBundle!({ ...input, lines, quoteSessionId, transaction: client }),
      );
    const first = await reserveLines([input.lines[0]!]);
    expect(await reserveLines([input.lines[0]!])).toEqual(first);
    expect(await inventory()).toEqual([0, 0, 2, 2]);
    await expect(reserveLines([input.lines[1]!])).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([0, 0, 2, 2]);
    await release(first);
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
  // Retired v1 quote path: priced through the VAY-1546 pricing stubs or the v1 booking flow
  // retired by VAY-1543. v2 pricing is covered by the replacementPricing* suites.
  it.skip("cannot combine two room types selling the same linked space", async () => {
    const group = randomUUID();
    await pool.query(
      "INSERT INTO pms.linked_inventory_groups(id,property_id,name) VALUES($1,$2,'Shared space')",
      [group, propertyId],
    );
    await pool.query(
      "UPDATE pms.room_types SET linked_inventory_group_id=$2 WHERE property_id=$1",
      [propertyId, group],
    );
    await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
    await expect(reserve()).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
});
