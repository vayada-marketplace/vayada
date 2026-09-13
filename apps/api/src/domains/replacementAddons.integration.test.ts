import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockReplacementAddons } from "./replacementAddons.js";
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
        leadTime: null,
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
        leadTime: "24 hours",
      });
    }
    const kwd = await fixture("KWD"),
      jpy = await fixture("JPY");
    expect((await kwd.read())?.addons[0]?.amountMinor).toBe("12500");
    expect(await jpy.read()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET price_amount=0 WHERE id=$1", [jpy.id]);
    expect((await jpy.read())?.addons[0]?.amountMinor).toBe("0");
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
});
