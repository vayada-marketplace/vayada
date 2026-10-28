import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockReplacementAddonAmounts } from "./replacementAddonAmounts.js";
import type { ReplacementStay } from "@vayada/domain-booking";
import { lockReplacementAddons } from "./replacementAddons.js";
import { pricingLeadTimeTestZone } from "./pricingLeadTimeTestZone.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("current Booking add-on owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  async function fixture(currency = "EUR") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID(),
      id = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Add-on test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,price_amount,currency)
      VALUES($1,$2,'Transfer','per_stay',12.50,$3)`,
      [id, propertyId, currency],
    );
    const input: Parameters<typeof lockReplacementAddons>[1] = {
      propertyId,
      currency,
      addonIds: [id],
    };
    const read = async (value = input) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockReplacementAddons(client, value);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { id, input, read };
  }
  it("preserves all pricing models, exact prices and property/partner terms", async () => {
    const f = await fixture();
    expect((await f.read())?.addons).toEqual([
      {
        id: f.id,
        name: "Transfer",
        amountMinor: "1250",
        currency: "EUR",
        pricingModel: "per_stay",
        maxQuantity: 1,
        maxGuests: null,
        leadTimeHours: null,
        legacyLeadTime: false,
        scheduleMode: "guest_pick",
        bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
        ownershipKind: "property",
        partnerCommissionRate: null,
      },
    ]);
    for (const model of ["per_stay", "per_night", "per_guest", "per_guest_night"]) {
      await pool.query(
        `UPDATE booking.addon_definitions SET pricing_model=$2, ownership_kind='partner',partner_commission_rate=12.3456,
        metadata='{"maxQuantity":4,"maxGuests":2,"leadTime":"24 hours"}' WHERE id=$1`,
        [f.id, model],
      );
      expect((await f.read())?.addons[0]).toMatchObject({
        pricingModel: model,
        amountMinor: "1250",
        ownershipKind: "partner",
        partnerCommissionRate: "12.3456",
        maxQuantity: 4,
        maxGuests: 2,
        leadTimeHours: null,
        legacyLeadTime: true,
      });
    }
    const kwd = await fixture("KWD"),
      jpy = await fixture("JPY");
    expect((await kwd.read())?.addons[0]?.amountMinor).toBe("12500");
    expect(await jpy.read()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET price_amount=0 WHERE id=$1", [jpy.id]);
    expect((await jpy.read())?.addons[0]?.amountMinor).toBe("0");
    // IDR keeps scale 2 but prices whole rupiah (VAY-2085): 12.50 is refused, 125000 is not.
    const idr = await fixture("IDR");
    expect(await idr.read()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET price_amount=125000 WHERE id=$1", [
      idr.id,
    ]);
    expect((await idr.read())?.addons[0]?.amountMinor).toBe("12500000");
  });
  it("rejects missing, foreign, hidden, inactive, mismatched and malformed definitions", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const addonIds of [[randomUUID()], [other.id], [f.id, f.id.toUpperCase()], ["invalid"]])
      expect(await f.read({ ...f.input, addonIds })).toBeNull();
    expect(await f.read({ ...f.input, currency: "USD" })).toBeNull();
    expect(await f.read({ ...f.input, currency: "XYZ" })).toBeNull();
    for (const status of ["disabled", "retired"]) {
      await pool.query("UPDATE booking.addon_definitions SET status=$2 WHERE id=$1", [
        f.id,
        status,
      ]);
      expect(await f.read()).toBeNull();
    }
    await pool.query(
      "UPDATE booking.addon_definitions SET status='active',public_visible=false WHERE id=$1",
      [f.id],
    );
    expect(await f.read()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET public_visible=true WHERE id=$1", [
      f.id,
    ]);
    for (const metadata of [
      [],
      { maxQuantity: null },
      { maxQuantity: 0 },
      { maxGuests: 1.5 },
      { leadTime: 12 },
      { leadTimeHours: 36 },
      { leadTimeHours: "24" },
    ]) {
      await pool.query("UPDATE booking.addon_definitions SET metadata=$2 WHERE id=$1", [
        f.id,
        JSON.stringify(metadata),
      ]);
      expect(await f.read()).toBeNull();
    }
  });
  it("binds owner mutations and empty selections to current property-scoped source evidence", async () => {
    const f = await fixture(),
      other = await fixture();
    const before = await f.read();
    expect(
      (
        await f.read({
          ...f.input,
          propertyId: f.input.propertyId.toUpperCase(),
          addonIds: [f.id.toUpperCase()],
        })
      )?.sourceRevision,
    ).toBe(before?.sourceRevision);
    await pool.query("UPDATE booking.addon_definitions SET price_amount=15 WHERE id=$1", [f.id]);
    expect((await f.read())?.sourceRevision).not.toBe(before?.sourceRevision);
    const empty = await f.read({ ...f.input, addonIds: [] });
    expect(empty?.addons).toEqual([]);
    expect(empty?.sourceRevision).not.toBe(
      (await other.read({ ...other.input, addonIds: [] }))?.sourceRevision,
    );
    expect(await f.read({ ...f.input, propertyId: randomUUID(), addonIds: [] })).toBeNull();
    const id = randomUUID();
    await pool.query(
      `INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,currency)
      VALUES($1,$2,'Other','per_night','EUR')`,
      [id, f.input.propertyId],
    );
    expect((await f.read({ ...f.input, addonIds: [] }))?.sourceRevision).not.toBe(
      empty?.sourceRevision,
    );
    expect(await f.read({ ...f.input, addonIds: [id, f.id] })).toEqual(
      await f.read({ ...f.input, addonIds: [f.id, id] }),
    );
  });
  it("retains caller locks against edits, deletes and new definitions", async () => {
    const f = await fixture(),
      reader = await pool.connect(),
      writer = await pool.connect();
    try {
      await reader.query("BEGIN");
      expect(await lockReplacementAddons(reader, f.input)).not.toBeNull();
      for (const sql of [
        "UPDATE booking.addon_definitions SET price_amount=20 WHERE id=$1",
        "DELETE FROM booking.addon_definitions WHERE id=$1",
        `INSERT INTO booking.addon_definitions(property_id,name,pricing_model,currency)
          SELECT property_id,'New','per_stay','EUR' FROM booking.addon_definitions WHERE id=$1`,
      ]) {
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(writer.query(sql, [f.id])).rejects.toMatchObject({ code: "55P03" });
        await writer.query("ROLLBACK");
      }
    } finally {
      await reader.query("ROLLBACK");
      await writer.query("ROLLBACK");
      reader.release();
      writer.release();
    }
  });
  async function amountFixture() {
    const f = await fixture();
    const stay: ReplacementStay = {
      propertyId: f.input.propertyId,
      currency: "EUR",
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      rooms: [
        {
          selectionId: "room",
          roomTypeId: randomUUID(),
          offerId: "offer",
          guests: { adults: 2, childAgesAtCheckIn: [8] },
        },
      ],
      addons: [{ version: "addon-selection.v2", id: f.id, quantity: 1, dates: null, people: null }],
      promoCode: null,
    };
    const amounts = async (value: unknown = stay) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockReplacementAddonAmounts(client, value);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, stay, amounts };
  }
  it("calculates all four models from saved definitions and selected people/dates", async () => {
    const f = await amountFixture();
    await pool.query(
      "UPDATE booking.addon_definitions SET price_amount=20,metadata='{\"maxQuantity\":3}' WHERE id=$1",
      [f.id],
    );
    const selected = f.stay.addons[0];
    const people = [
      { selectionId: "room", kind: "adult", index: 0 },
      { selectionId: "room", kind: "child", index: 0 },
    ];
    for (const [model, quantity, participants, dates, total] of [
      ["per_stay", 3, null, null, "6000"],
      ["per_night", 1, null, null, "6000"],
      ["per_night", 1, null, ["2026-10-01", "2026-10-03"], "4000"],
      ["per_guest", 1, people, null, "4000"],
      ["per_guest_night", 1, people, ["2026-10-01", "2026-10-03"], "8000"],
      ["per_guest_night", 1, people.slice(0, 1), ["2026-10-03"], "2000"],
    ]) {
      await pool.query("UPDATE booking.addon_definitions SET pricing_model=$2 WHERE id=$1", [
        f.id,
        model,
      ]);
      const result = await f.amounts({
        ...f.stay,
        addons: [{ ...selected, quantity, people: participants, dates }],
      });
      expect(result?.totalMinor).toBe(total);
      expect(result?.lines[0].definition.amountMinor).toBe("2000");
      expect(result?.sourceRevision).toMatch(/^booking.addons.v2:/);
    }
  });
  it("enforces model-specific selections, limits and date boundaries without legacy inference", async () => {
    const f = await amountFixture(),
      a = f.stay.addons[0];
    for (const addon of [
      { id: f.id, quantity: 1, dates: null },
      { ...a, quantity: 2 },
      { ...a, people: [{ selectionId: "room", kind: "adult", index: 0 }] },
      { ...a, dates: ["2026-10-01", "2026-10-02"] },
    ])
      expect(await f.amounts({ ...f.stay, addons: [addon] })).toBeNull();
    expect(
      (await f.amounts({ ...f.stay, addons: [{ ...a, dates: ["2026-10-04"] }] }))?.totalMinor,
    ).toBe("1250");
    await pool.query("UPDATE booking.addon_definitions SET pricing_model='per_night' WHERE id=$1", [
      f.id,
    ]);
    expect(await f.amounts({ ...f.stay, addons: [{ ...a, dates: ["2026-10-04"] }] })).toBeNull();
    await pool.query(
      "UPDATE booking.addon_definitions SET pricing_model='per_guest',metadata='{\"maxQuantity\":3,\"maxGuests\":1}' WHERE id=$1",
      [f.id],
    );
    expect(await f.amounts()).toBeNull();
    const people = [0, 1].map((index) => ({ selectionId: "room", kind: "adult", index }));
    expect(await f.amounts({ ...f.stay, addons: [{ ...a, people }] })).toBeNull();
    expect(
      await f.amounts({ ...f.stay, addons: [{ ...a, quantity: 2, people: people.slice(0, 1) }] }),
    ).toBeNull();
    expect(
      (await f.amounts({ ...f.stay, addons: [{ ...a, people: people.slice(0, 1) }] }))?.totalMinor,
    ).toBe("1250");
  });
  it("fails unavailable owners/lead-time rules and retains economic snapshots and empty evidence", async () => {
    const f = await amountFixture();
    await pool.query(
      'UPDATE booking.addon_definitions SET metadata=\'{"leadTime":"24 hours"}\' WHERE id=$1',
      [f.id],
    );
    expect(await f.amounts()).toBeNull();
    await pool.query(
      "UPDATE booking.addon_definitions SET metadata='{}',ownership_kind='partner',partner_commission_rate=15.1234 WHERE id=$1",
      [f.id],
    );
    const result = await f.amounts();
    expect(result?.lines[0].definition).toMatchObject({
      ownershipKind: "partner",
      partnerCommissionRate: "15.1234",
    });
    expect(await f.amounts({ ...f.stay, addons: [] })).toMatchObject({
      totalMinor: "0",
      lines: [],
    });
    await pool.query("UPDATE booking.addon_definitions SET public_visible=false WHERE id=$1", [
      f.id,
    ]);
    expect(await f.amounts()).toBeNull();
    expect(result?.totalMinor).toBe("1250");
    await pool.query(
      "UPDATE booking.addon_definitions SET public_visible=true,metadata='{\"maxGuests\":2}' WHERE id=$1",
      [f.id],
    );
    expect(await f.amounts()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET metadata='{}' WHERE id=$1", [f.id]);
    const scheduled = await f.amounts({
      ...f.stay,
      addons: [{ ...f.stay.addons[0], dates: ["2026-10-04"] }],
    });
    expect(scheduled?.totalMinor).toBe(result?.totalMinor);
    expect(scheduled?.requestKey).not.toBe(result?.requestKey);
  });
  it("adds an extra with a lead time only when check-in is that far away (VAY-2232)", async () => {
    const f = await amountFixture();
    // The notice is checked against the database clock in the hotel's zone. The hotel sits where
    // that clock reads noon, so its midnight stays hours away from every read (VAY-2382).
    const zone = await pricingLeadTimeTestZone(pool);
    const stayFrom = (days: number) => ({
      ...f.stay,
      checkIn: zone.plusDays(days),
      checkOut: zone.plusDays(days + 2),
    });
    await pool.query(
      `UPDATE booking.addon_definitions SET metadata='{"leadTimeHours":168,"leadTime":"2 days"}'
       WHERE id=$1`,
      [f.id],
    );
    // Without the hotel's time zone the notice can't be checked.
    expect(await f.amounts(stayFrom(30))).toBeNull();
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,$2)",
      [f.input.propertyId, zone.timeZone],
    );
    expect((await f.amounts(stayFrom(30)))?.lines[0].definition).toMatchObject({
      leadTimeHours: 168,
      legacyLeadTime: false,
    });
    expect((await f.amounts(stayFrom(8)))?.totalMinor).toBe("1250");
    // Arriving in 7 days counts from 00:00 without a check-in time: less than a week away.
    expect(await f.amounts(stayFrom(7))).toBeNull();
    // The hotel's check-in time moves the arrival to 23:59, a week away again.
    await pool.query(
      "INSERT INTO hotel_catalog.property_policy_summaries(property_id,check_in_time) VALUES($1,'23:59')",
      [f.input.propertyId],
    );
    expect((await f.amounts(stayFrom(7)))?.totalMinor).toBe("1250");
    expect(await f.amounts(stayFrom(6))).toBeNull();
    // A saved "no lead time" choice ignores the old text next to it.
    await pool.query(
      `UPDATE booking.addon_definitions SET metadata='{"leadTimeHours":null,"leadTime":"2 days"}'
       WHERE id=$1`,
      [f.id],
    );
    expect((await f.amounts(stayFrom(0)))?.totalMinor).toBe("1250");
  });
  it("dates an add-on by when it happens and keeps a guest's day to its weekdays (VAY-2391)", async () => {
    const f = await amountFixture(),
      a = f.stay.addons[0];
    const schedule = (mode: string, weekdays = "{1,2,3,4,5,6,7}", model = "per_stay") =>
      pool.query(
        "UPDATE booking.addon_definitions SET schedule_mode=$2,bookable_weekdays=$3,pricing_model=$4 WHERE id=$1",
        [f.id, mode, weekdays, model],
      );
    const dates = async (value: unknown = f.stay) => (await f.amounts(value))?.lines[0]?.dates;
    // The stay runs Thursday 1 to Sunday 4 October. A guest-pick add-on without a day stays undated.
    expect(await dates()).toBeNull();
    await schedule("arrival");
    expect(await dates()).toEqual(["2026-10-01"]);
    expect((await f.amounts())?.totalMinor).toBe("1250");
    await schedule("departure");
    expect(await dates()).toEqual(["2026-10-04"]);
    await schedule("anytime");
    expect(await dates()).toEqual([]);
    // Today's booking page sends a day for every one-off extra and offers every day of the stay. Until
    // the page that sends none is live, those days still count; VAY-2391 part 4 refuses them.
    expect(await dates({ ...f.stay, addons: [{ ...a, dates: ["2026-10-02"] }] })).toEqual([
      "2026-10-02",
    ]);
    // Friday and Saturday only, yet Thursday and the check-out day are still accepted.
    await schedule("guest_pick", "{5,6}");
    for (const day of ["2026-10-02", "2026-10-01", "2026-10-04"])
      expect(await dates({ ...f.stay, addons: [{ ...a, dates: [day] }] })).toEqual([day]);
    // A per-night price is every night, whatever was stored by an older writer.
    await schedule("guest_pick", "{5}", "per_night");
    expect(await dates()).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect((await f.amounts())?.lines[0].definition).toMatchObject({ scheduleMode: "daily" });
    await expect(schedule("weekly")).rejects.toMatchObject({
      constraint: "chk_addon_definitions_schedule_mode",
    });
    await expect(schedule("arrival", "{0}")).rejects.toMatchObject({
      constraint: "chk_addon_definitions_bookable_weekdays",
    });
  });
  it("bounds aggregate arithmetic and uses exact saved KWD unit prices", async () => {
    const f = await amountFixture();
    await pool.query(
      "UPDATE booking.addon_definitions SET currency='KWD',price_amount=12.50 WHERE id=$1",
      [f.id],
    );
    expect((await f.amounts({ ...f.stay, currency: "KWD" }))?.totalMinor).toBe("12500");
    await pool.query(
      "UPDATE booking.addon_definitions SET currency='EUR',price_amount=9999999999999.99,pricing_model='per_night',metadata='{\"maxQuantity\":99}' WHERE id=$1",
      [f.id],
    );
    expect(
      await f.amounts({
        ...f.stay,
        checkOut: "2027-10-02",
        addons: [{ ...f.stay.addons[0], quantity: 99 }],
      }),
    ).toBeNull();
  });
});
