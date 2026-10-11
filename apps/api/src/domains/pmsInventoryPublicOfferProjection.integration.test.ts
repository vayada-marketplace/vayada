import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createTargetPmsInventoryPublicOfferProjection } from "./pmsInventoryPublicOfferProjection.js";
import {
  createReplacementPricingStore,
  type PricingStorageSnapshot,
} from "./replacementPricingStore.js";

const url = process.env["TEST_DATABASE_URL"];
const now = new Date("2030-01-10T12:00:00Z");

describe.skipIf(!url)("pricing-v2 public offer projection PostgreSQL (VAY-2123)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const projector = createTargetPmsInventoryPublicOfferProjection({
    connectionString: url ?? "unused",
    pool,
    now: () => now,
  });
  afterAll(() => pool.end());

  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID(),
      actorUserId = randomUUID(),
      organizationId = randomUUID(),
      roomTypeId = randomUUID(),
      unpricedRoomId = randomUUID();
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Offer test')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Offer test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
      (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
      VALUES($1::uuid,$1::text,'Offer test',$1::text,'en',ARRAY['en'],'complete')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
      (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
       default_currency,supported_currencies,profile_status)
      VALUES($1::uuid,$1::text,$1::text,'https://example.test/hotel','https://example.test',
        'Etc/UTC','EUR',ARRAY['EUR'],'public')`,
      [propertyId],
    );
    for (const [room, name] of [
      [roomTypeId, "Priced room"],
      [unpricedRoomId, "Unpriced room"],
    ])
      await pool.query(
        "INSERT INTO pms.room_types(id,property_id,name,active) VALUES($1,$2,$3,true)",
        [room, propertyId, name],
      );
    const day = (room: string, date: string, available: number, status = "open", rateGate = true) =>
      pool.query(
        `INSERT INTO pms.inventory_days(property_id,room_type_id,stay_date,total_count,available_count,status,rate_gate_open)
        VALUES($1,$2,$3,2,$4,$5,$6)`,
        [propertyId, room, date, available, status, rateGate],
      );
    await day(roomTypeId, "2030-01-09", 2); // yesterday: outside the public window
    await day(roomTypeId, "2030-01-10", 2);
    await day(roomTypeId, "2030-01-11", 1);
    await day(roomTypeId, "2030-01-12", 0);
    await day(roomTypeId, "2030-01-13", 2, "closed");
    await day(roomTypeId, "2030-01-14", 2); // stop-sell in the prices
    await day(roomTypeId, "2030-01-15", 2, "open", false);
    await day(unpricedRoomId, "2030-01-10", 2);
    // A sellable row from the retired pricing, as the backend migration wrote them.
    await pool.query(
      `INSERT INTO distribution.public_room_offer_snapshots
      (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,currency,freshness_status)
      VALUES($1::uuid,$2::uuid,'2030-01-10',$2::uuid::text || ':flexible',2,90,'EUR','fresh')`,
      [propertyId, unpricedRoomId],
    );
    const scope = { propertyId, actorUserId, organizationId };
    const sources = { room: "1", terms: "1", finance: "1" };
    const store = createReplacementPricingStore(pool, {
      async lock() {
        return sources;
      },
      async validate() {
        return true;
      },
      async allowCurrencyChange() {
        return false;
      },
    });
    const rules = {
      minArrivalNights: 1,
      maxStayNights: 14,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
    };
    const snapshot = (revision: number, offerId = "flex"): PricingStorageSnapshot => ({
      currency: "EUR",
      ownerReferences: { terms: "terms-1", finance: "finance-1" },
      rooms: [
        {
          version: "pricing.v2",
          propertyId,
          roomTypeId,
          revision,
          currency: "EUR",
          capacity: { total: 2, adults: 2, children: 1 },
          children: {
            adultFromAge: 12,
            bands: [
              { fromAge: 0, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true },
            ],
          },
          offers: [
            {
              id: offerId,
              termsRevision: "terms-1",
              meal: {
                kind: "breakfast",
                charge: { kind: "person", adultMinor: "1250", childBandAmountsMinor: ["500"] },
              },
              price: {
                kind: "independent",
                calendar: {
                  base: { mode: "occupancy", amountsMinor: ["10000", "14000"] },
                  months: [],
                  seasons: [],
                  weekdays: [],
                  dates: [],
                },
              },
              restrictions: {
                kind: "own",
                rules,
                seasons: [],
                dates: [{ date: "2030-01-14", rules: { ...rules, stopSell: true } }],
              },
            },
          ],
        },
      ],
    });
    const save = (revision: number, offerId?: string) =>
      store.save(scope, {
        requestId: randomUUID(),
        expectedRevision: revision - 1,
        sources,
        snapshot: snapshot(revision, offerId),
      });
    const offers = async () =>
      (
        await pool.query(
          `SELECT public_offer_key AS key,to_char(stay_date,'YYYY-MM-DD') AS date,availability_status AS status,
            sellable_publicly AS sellable,available_rooms AS rooms,base_price_amount::text AS price,
            unavailable_reasons AS reasons,freshness_status AS freshness,rate_summary AS rate,occupancy
          FROM distribution.public_room_offer_snapshots WHERE property_id=$1 ORDER BY key,date`,
          [propertyId],
        )
      ).rows;
    return { propertyId, roomTypeId, unpricedRoomId, save, offers };
  }

  it("projects saved prices onto free rooms and closes everything else, all fresh", async () => {
    const f = await fixture();
    await f.save(1); // "Save prices" queues the refresh
    await expect(projector.projectPending({ propertyId: f.propertyId })).resolves.toEqual({
      profileAvailable: true,
      pendingEvents: 1,
      projectedOfferDays: 7,
    });
    const key = `pricing-v2:${f.roomTypeId}:flex`;
    const priced = (date: string, status: string, rooms: number, reasons: string[]) => ({
      key,
      date,
      status,
      sellable: status === "available" || status === "limited",
      rooms,
      price: "112.50",
      reasons,
      freshness: "fresh",
      rate: { mealPlan: "breakfast", minStayNights: 1, maxStayNights: 14 },
      occupancy: { maxAdults: 2, maxChildren: 1, maxOccupancy: 2 },
    });
    expect(await f.offers()).toEqual([
      expect.objectContaining({
        key: `${f.unpricedRoomId}:flexible`,
        status: "closed",
        sellable: false,
        rooms: 2,
        price: "90.00",
        reasons: ["unpublished"],
        freshness: "fresh",
      }),
      priced("2030-01-10", "available", 2, []),
      priced("2030-01-11", "limited", 1, []),
      priced("2030-01-12", "sold_out", 0, ["sold_out"]),
      priced("2030-01-13", "closed", 0, ["unpublished"]),
      priced("2030-01-14", "closed", 2, ["unpublished"]),
      priced("2030-01-15", "closed", 0, ["unpublished"]),
    ]);

    // A repeated refresh with nothing new writes nothing.
    await f.save(2);
    await expect(projector.projectPending({ propertyId: f.propertyId })).resolves.toMatchObject({
      projectedOfferDays: 0,
    });

    // Replacing the offer closes its old days and opens the new offer's.
    await f.save(3, "standard");
    await projector.projectPending({ propertyId: f.propertyId });
    const after = await f.offers();
    expect(after.filter((row) => row.key === key && row.sellable)).toEqual([]);
    expect(after.filter((row) => row.key === key).map((row) => row.reasons)).toEqual(
      Array(6).fill(["unpublished"]),
    );
    expect(
      after
        .filter((row) => row.key === `pricing-v2:${f.roomTypeId}:standard` && row.sellable)
        .map((row) => row.date),
    ).toEqual(["2030-01-10", "2030-01-11"]);
    expect(after.every((row) => row.freshness === "fresh")).toBe(true);

    // An inactive room sells nothing.
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.roomTypeId]);
    await f.save(4, "standard");
    await projector.projectPending({ propertyId: f.propertyId });
    expect((await f.offers()).filter((row) => row.sellable)).toEqual([]);
  });
});
