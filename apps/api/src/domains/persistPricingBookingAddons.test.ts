import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { historicalQuoteFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { persistPricingBookingAddons } from "./persistPricingBookingAddons.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { projectPricingBookingAddons } from "./pricingBookingAddons.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./pricingBookingAddons.js", () => ({ projectPricingBookingAddons: vi.fn() }));
function fixture() {
  const quote = historicalQuoteFixture(),
    bookingId = randomUUID(),
    addonId = randomUUID();
  quote.stay.propertyId = randomUUID();
  const scope = {
    propertyId: quote.stay.propertyId,
    organizationId: randomUUID(),
    authorityRevision: "authority:1",
  };
  const current = { kind: "current_quote_price", scope, quote } as unknown as Parameters<
    typeof persistPricingBookingAddons
  >[2];
  const row = {
    addonDefinitionId: addonId,
    addonSnapshot: { version: "booking.pricing-addon-selection.v1", pricingQuoteId: quote.quoteId },
    quantity: 1,
    serviceDate: quote.stay.checkIn,
    totalAmount: "12.5",
    currency: "EUR",
    ownershipKind: "partner",
    partnerCommissionRate: "12.5000",
  };
  const booking = {
    id: bookingId,
    check_in: quote.stay.checkIn,
    check_out: quote.stay.checkOut,
    currency: "EUR",
    room_count: 1,
    total_amount: "360.00",
    booking_metadata: { pricingQuoteId: quote.quoteId },
    lifecycle_status: "draft",
    edit_revision: 0,
  };
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(scope);
  vi.mocked(projectPricingBookingAddons).mockReturnValue([row] as unknown as ReturnType<
    typeof projectPricingBookingAddons
  >);
  return { current, row, booking, bookingId, addonId, scope };
}
beforeEach(() => vi.resetAllMocks());
it("stages exact captured extras then replays identical stored rows without inserting again", async () => {
  const f = fixture(),
    query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [f.booking] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: randomUUID() }] });
  expect(
    await persistPricingBookingAddons(
      { query } as unknown as PoolClient,
      "hotel",
      f.current,
      f.bookingId,
    ),
  ).toEqual({ count: 1, replayed: false });
  expect(query.mock.calls[2][1]).toEqual([
    f.scope.propertyId,
    f.bookingId,
    JSON.stringify([f.row]),
  ]);
  query
    .mockReset()
    .mockResolvedValueOnce({ rows: [f.booking] })
    .mockResolvedValueOnce({ rows: [{ ...f.row, edit_revision: 0, totalAmount: "12.50" }] });
  expect(
    await persistPricingBookingAddons(
      { query } as unknown as PoolClient,
      "hotel",
      f.current,
      f.bookingId,
    ),
  ).toEqual({ count: 1, replayed: true });
  expect(query).toHaveBeenCalledTimes(2);
});
it("rejects unavailable projections, crossed scope, changed bookings and conflicting saved extras", async () => {
  const f = fixture(),
    db = { query: vi.fn() };
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce({
    ...f.scope,
    organizationId: randomUUID(),
  });
  await expect(
    persistPricingBookingAddons(db as unknown as PoolClient, "hotel", f.current, f.bookingId),
  ).rejects.toThrow("unavailable");
  expect(db.query).not.toHaveBeenCalled();
  vi.mocked(projectPricingBookingAddons).mockReturnValueOnce(null);
  await expect(
    persistPricingBookingAddons(db as unknown as PoolClient, "hotel", f.current, f.bookingId),
  ).rejects.toThrow("unavailable");
  for (const patch of [
    { lifecycle_status: "confirmed" },
    { edit_revision: 1 },
    { total_amount: "1" },
    { booking_metadata: {} },
    { currency: "USD" },
    { check_out: "2026-10-04" },
  ]) {
    db.query.mockReset().mockResolvedValue({ rows: [{ ...f.booking, ...patch }] });
    await expect(
      persistPricingBookingAddons(db as unknown as PoolClient, "hotel", f.current, f.bookingId),
    ).rejects.toThrow("unavailable");
    expect(db.query).toHaveBeenCalledTimes(1);
  }
  for (const patch of [
    { edit_revision: 1 },
    { quantity: 2 },
    { totalAmount: "99" },
    { addonSnapshot: {} },
    { partnerCommissionRate: "15" },
    { serviceDate: "2026-10-02" },
  ]) {
    db.query
      .mockReset()
      .mockResolvedValueOnce({ rows: [f.booking] })
      .mockResolvedValueOnce({ rows: [{ ...f.row, edit_revision: 0, ...patch }] });
    await expect(
      persistPricingBookingAddons(db as unknown as PoolClient, "hotel", f.current, f.bookingId),
    ).rejects.toThrow("unavailable");
    expect(db.query).toHaveBeenCalledTimes(2);
  }
});
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL captured extra staging", () => {
  it("persists partner evidence once and rolls all staged booking/add-on rows back", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const f = fixture(),
      db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,($1::uuid)::text,'Synthetic extras')",
        [f.scope.propertyId],
      );
      await db.query(
        "INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,price_amount,currency,ownership_kind,partner_commission_rate) VALUES($1,$2,'Extra','per_stay',12.5,'EUR','partner',12.5)",
        [f.addonId, f.scope.propertyId],
      );
      await db.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,total_amount,room_count,booking_metadata)
        VALUES($1::uuid,$2,($1::uuid)::text,'draft',$3,$4,'EUR',360,1,$5)`,
        [
          f.bookingId,
          f.scope.propertyId,
          f.booking.check_in,
          f.booking.check_out,
          f.booking.booking_metadata,
        ],
      );
      expect(
        await persistPricingBookingAddons(
          db as unknown as PoolClient,
          "hotel",
          f.current,
          f.bookingId,
        ),
      ).toEqual({ count: 1, replayed: false });
      expect(
        await persistPricingBookingAddons(
          db as unknown as PoolClient,
          "hotel",
          f.current,
          f.bookingId,
        ),
      ).toEqual({ count: 1, replayed: true });
      const saved = (
        await db.query(
          "SELECT addon_snapshot,total_amount::text,ownership_kind_snapshot,partner_commission_rate_snapshot::text FROM booking.booking_addon_selections WHERE guest_booking_id=$1",
          [f.bookingId],
        )
      ).rows;
      expect(saved).toEqual([
        {
          addon_snapshot: f.row.addonSnapshot,
          total_amount: "12.50",
          ownership_kind_snapshot: "partner",
          partner_commission_rate_snapshot: "12.5000",
        },
      ]);
      await db.query("ROLLBACK");
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM booking.booking_addon_selections WHERE guest_booking_id=$1",
            [f.bookingId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await db.query("SELECT count(*)::int AS n FROM booking.guest_bookings WHERE id=$1", [
            f.bookingId,
          ])
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query("ROLLBACK");
      await db.end();
    }
  });
});
