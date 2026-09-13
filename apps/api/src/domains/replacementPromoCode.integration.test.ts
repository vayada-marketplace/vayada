import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockReplacementPromoCode } from "./replacementPromoCode.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("current Booking promo code owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  async function fixture(currency = "EUR") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID(),
      roomTypeId = randomUUID(),
      id = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Promo test')",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Pacific/Kiritimati')",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO booking.booking_settings(property_id,default_currency) VALUES($1,$2)",
      [propertyId, currency],
    );
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Promo room')", [
      roomTypeId,
      propertyId,
    ]);
    const today = (
      await pool.query(
        "SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS date",
      )
    ).rows[0].date as string;
    await pool.query(
      `INSERT INTO booking.promo_definitions(id,property_id,code,discount_type,discount_value,
      max_uses,min_booking_value,valid_from,valid_until,stay_date_from,stay_date_until)
      VALUES($1,$2,'SAVE','percentage',12.50,2,100,$3,$3,'2026-11-01','2026-11-30')`,
      [id, propertyId, today],
    );
    const input = {
      propertyId,
      currency,
      code: "save",
      checkIn: "2026-11-01",
      rooms: [{ selectionId: "one", roomTypeId }],
      bookingAmountMinor: currency === "KWD" ? "100000" : currency === "JPY" ? "100" : "10000",
    };
    const read = async (value = input) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockReplacementPromoCode(client, value);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { id, input, today, read };
  }
  it("preserves independent inclusive booking and arrival windows using the property clock", async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({
      code: "SAVE",
      discount: { kind: "percentage", basisPoints: 1250 },
      bookingLocalDate: f.today,
      eligibleSelectionIds: ["one"],
      minimumBookingMinor: "10000",
    });
    expect(await f.read({ ...f.input, checkIn: "2026-11-30" })).not.toBeNull();
    expect(await f.read({ ...f.input, checkIn: "2026-10-31" })).toBeNull();
    expect(await f.read({ ...f.input, checkIn: "2026-12-01" })).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET valid_from=NULL,valid_until=$2::date-1 WHERE id=$1",
      [f.id, f.today],
    );
    expect(await f.read()).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET valid_until=NULL,valid_from=$2::date+1 WHERE id=$1",
      [f.id, f.today],
    );
    expect(await f.read()).toBeNull();
    await pool.query("UPDATE booking.promo_definitions SET valid_from=NULL WHERE id=$1", [f.id]);
    expect(await f.read()).not.toBeNull();
  });
  it("checks usage, active state, minimum value and exact room targeting", async () => {
    const f = await fixture(),
      other = await fixture();
    expect(await f.read({ ...f.input, bookingAmountMinor: "9999" })).toBeNull();
    expect(await f.read({ ...f.input, rooms: other.input.rooms })).toBeNull();
    await pool.query("UPDATE booking.promo_definitions SET applicable_room_ids=$2 WHERE id=$1", [
      f.id,
      [other.input.rooms[0].roomTypeId],
    ]);
    expect(await f.read()).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET applicable_room_ids=$2,current_uses=2 WHERE id=$1",
      [f.id, [f.input.rooms[0].roomTypeId]],
    );
    expect(await f.read()).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET current_uses=0,is_active=false WHERE id=$1",
      [f.id],
    );
    expect(await f.read()).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET is_active=true,status='retired' WHERE id=$1",
      [f.id],
    );
    expect(await f.read()).toBeNull();
  });
  it("converts fixed/minimum decimals exactly in the saved currency and rejects precision loss", async () => {
    const f = await fixture("KWD");
    await pool.query(
      "UPDATE booking.promo_definitions SET discount_type='fixed',discount_value=1.25 WHERE id=$1",
      [f.id],
    );
    expect(await f.read()).toMatchObject({
      discount: { kind: "fixed", amountMinor: "1250" },
      minimumBookingMinor: "100000",
    });
    expect(await f.read({ ...f.input, currency: "EUR" })).toBeNull();
    const yen = await fixture("JPY");
    await pool.query(
      "UPDATE booking.promo_definitions SET discount_type='fixed',discount_value=1.25 WHERE id=$1",
      [yen.id],
    );
    expect(await yen.read()).toBeNull();
    await pool.query("UPDATE booking.promo_definitions SET discount_value=2 WHERE id=$1", [yen.id]);
    expect(await yen.read()).toMatchObject({ discount: { kind: "fixed", amountMinor: "2" } });
  });
  it("binds source identity to saved policy and usage without redeeming the code", async () => {
    const f = await fixture(),
      first = await f.read();
    expect(first?.sourceRevision).toMatch(/^booking\.promo-code\.v2:[a-f0-9]{64}$/);
    expect((await f.read())?.sourceRevision).toBe(first?.sourceRevision);
    await pool.query("UPDATE booking.promo_definitions SET current_uses=1 WHERE id=$1", [f.id]);
    expect((await f.read())?.sourceRevision).not.toBe(first?.sourceRevision);
    expect(
      (await pool.query("SELECT current_uses FROM booking.promo_definitions WHERE id=$1", [f.id]))
        .rows[0].current_uses,
    ).toBe(1);
  });
  it("holds policy, settings and code insertion locks until the caller completes", async () => {
    const f = await fixture(),
      client = await pool.connect(),
      writer = new pg.Pool({ connectionString: url, max: 1, options: "-c lock_timeout=100ms" });
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPromoCode(client, f.input)).not.toBeNull();
      await expect(
        writer.query(
          "UPDATE booking.promo_definitions SET current_uses=current_uses+1 WHERE id=$1",
          [f.id],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "UPDATE booking.booking_settings SET default_currency='USD' WHERE property_id=$1",
          [f.input.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "INSERT INTO booking.promo_definitions(property_id,code,discount_type,discount_value) VALUES($1,'NEW','percentage',10)",
          [f.input.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });
  it("fails closed on missing settings, timezone and malformed requests", async () => {
    const f = await fixture();
    for (const value of [
      { ...f.input, code: "missing" },
      { ...f.input, bookingAmountMinor: "1.00" },
      { ...f.input, checkIn: "bad" },
      { ...f.input, rooms: [] },
      { ...f.input, rooms: [...f.input.rooms, ...f.input.rooms] },
    ])
      expect(await f.read(value)).toBeNull();
    await pool.query(
      "UPDATE hotel_catalog.property_locations SET timezone=NULL WHERE property_id=$1",
      [f.input.propertyId],
    );
    expect(await f.read()).toBeNull();
    await pool.query("DELETE FROM booking.booking_settings WHERE property_id=$1", [
      f.input.propertyId,
    ]);
    expect(await f.read()).toBeNull();
  });
});
