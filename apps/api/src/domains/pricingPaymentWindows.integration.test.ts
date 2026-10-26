import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  pricingPaymentWindowAllows,
  readPaymentMethodWindows,
  replacePaymentMethodWindows,
} from "./pricingPaymentWindows.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Booking windows per payment method (VAY-2348)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  afterAll(() => pool.end());

  async function hotel() {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("test database required");
    const propertyId = randomUUID();
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Payment windows test')",
      [propertyId],
    );
    // UTC all year (property time zones are Area/City) and no check-in time: the arrival day
    // starts at 00:00 UTC.
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Atlantic/Reykjavik')",
      [propertyId],
    );
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Windows test')", [
      userId,
      `windows-${userId}@example.test`,
    ]);
    const audit = { actorUserId: userId, requestId: `request-${userId}`, correlationId: null };
    return { propertyId, audit };
  }

  /** The UTC date `days` from the database's today. */
  async function dayFromNow(days: number) {
    const row = (
      await pool.query<{ day: string }>(
        "SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date + $1::int)::text AS day",
        [days],
      )
    ).rows[0];
    return row!.day;
  }

  it("refuses windows the database rules don't allow", async () => {
    const { propertyId } = await hotel();
    const insert = (method: string, kind: string, amount: number, unit: string) =>
      pool.query(
        `INSERT INTO finance.payment_method_booking_windows(property_id,payment_method,window_kind,amount,unit)
         VALUES($1,$2,$3,$4,$5)`,
        [propertyId, method, kind, amount, unit],
      );
    for (const [method, kind, amount, unit] of [
      ["paypal", "at_least", 3, "days"],
      ["card", "at_least", 72, "hours"],
      ["card", "within", 0, "hours"],
      ["card", "at_least", 366, "days"],
      ["card", "within", 8761, "hours"],
      ["bank_transfer", "at_least", 2, "days"],
      ["bank_transfer", "within", 48, "hours"],
      ["bank_transfer", "within", 2, "days"],
    ] as const)
      await expect(insert(method, kind, amount, unit)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("bank_transfer", "at_least", 3, "days")).resolves.toBeDefined();
    await expect(insert("pay_at_property", "within", 49, "hours")).resolves.toBeDefined();
  });

  it("saves the whole set, drops methods left out and audits each save", async () => {
    const { propertyId, audit } = await hotel();
    await expect(readPaymentMethodWindows(pool, propertyId)).resolves.toEqual({});
    const example = {
      bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
      pay_at_property: { kind: "within", amount: 48, unit: "hours" },
    } as const;
    await expect(
      replacePaymentMethodWindows(pool, { propertyId, windows: example, audit }),
    ).resolves.toEqual(example);
    await expect(
      replacePaymentMethodWindows(pool, {
        propertyId,
        windows: { bank_transfer: { kind: "within", amount: 10, unit: "days" } },
        audit,
      }),
    ).resolves.toEqual({ bank_transfer: { kind: "within", amount: 10, unit: "days" } });
    await expect(
      replacePaymentMethodWindows(pool, { propertyId, windows: {}, audit }),
    ).resolves.toEqual({});
    const audited = await pool.query(
      `SELECT actor_user_id::text, redacted_payload FROM platform.product_audit_events
       WHERE property_id=$1 AND action='finance.payment_method_windows.updated' ORDER BY occurred_at`,
      [propertyId],
    );
    expect(audited.rows).toHaveLength(3);
    expect(audited.rows[0]).toEqual({
      actor_user_id: audit.actorUserId,
      redacted_payload: { windows: example },
    });
  });

  it("checks each method's window against the database clock, other hotels untouched", async () => {
    const { propertyId, audit } = await hotel();
    const other = await hotel();
    await replacePaymentMethodWindows(pool, {
      propertyId,
      windows: {
        bank_transfer: { kind: "at_least", amount: 7, unit: "days" },
        pay_at_property: { kind: "within", amount: 2, unit: "days" },
      },
      audit,
    });
    const allows = (method: string, days: number, id = propertyId) =>
      dayFromNow(days).then((checkIn) => pricingPaymentWindowAllows(pool, id, method, checkIn));
    // Arrival at 00:00 UTC: 8 days ahead is at least 7 days away, 7 days ahead is not quite.
    await expect(allows("bank_transfer", 8)).resolves.toBe(true);
    await expect(allows("bank_transfer", 7)).resolves.toBe(false);
    // Within 2 days: tomorrow and the day after (less than 48 h), not three days out.
    await expect(allows("pay_at_property", 1)).resolves.toBe(true);
    await expect(allows("pay_at_property", 2)).resolves.toBe(true);
    await expect(allows("pay_at_property", 3)).resolves.toBe(false);
    // No window: no limit. PayPal never has one.
    await expect(allows("card", 300)).resolves.toBe(true);
    await expect(allows("paypal", 1)).resolves.toBe(true);
    await expect(allows("pay_at_property", 30, other.propertyId)).resolves.toBe(true);
    // Without a time zone the window can't be checked: refused.
    await pool.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
      propertyId,
    ]);
    await expect(allows("bank_transfer", 30)).resolves.toBe(false);
    await expect(allows("card", 30)).resolves.toBe(true);
  });
});
