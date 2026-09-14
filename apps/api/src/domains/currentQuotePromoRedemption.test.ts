import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { historicalQuoteFixture } from "./pricingAcceptanceHistory.fixtures.js";
import {
  redeemCurrentQuotePromo,
  redeemLockedCurrentQuotePromo,
} from "./currentQuotePromoRedemption.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentPricingQuoteStore.js", () => ({ decodeCurrentPricingQuoteRecord: vi.fn() }));
const bookingId = "10000000-0000-4000-8000-000000000005";
const code = {
  id: "10000000-0000-4000-8000-000000000006",
  code: "SAVE",
  sourceRevision: "promo:1",
};
let current: Parameters<typeof redeemLockedCurrentQuotePromo>[2];
let booking: Record<string, unknown>, prior: Record<string, unknown>[], writes: number;
const query = vi.fn(async (sql: string, args: unknown[]) => {
  if (sql.includes("FROM booking.pricing_quotes"))
    return { rows: [{ id: current.quote.quoteId, payload: {} }] };
  if (sql.includes("FROM booking.guest_bookings")) return { rows: [booking] };
  if (sql.includes("FROM booking.promo_applications")) return { rows: prior };
  expect(sql).toContain("WITH consumed AS");
  expect(sql).toContain("current_uses<max_uses");
  expect(sql).toContain("INSERT INTO booking.promo_applications");
  writes++;
  const metadata = args[6] as Record<string, unknown>;
  prior = [
    {
      id: "application",
      guest_booking_id: bookingId,
      application_status: "applied",
      currency: args[5],
      discount_amount: args[4],
      metadata,
    },
  ];
  return { rows: [{ id: "application" }], rowCount: 1 };
});
const client = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.clearAllMocks();
  writes = 0;
  prior = [];
  const quote = historicalQuoteFixture();
  current = {
    kind: "current_quote_price",
    quote,
    scope: {
      propertyId: quote.stay.propertyId,
      organizationId: "organization",
      authorityRevision: "authority:1",
    },
    calculation: { code: { ...code }, discounts: { codeMinor: "2000" } },
  } as unknown as typeof current;
  booking = {
    id: bookingId,
    check_in: quote.stay.checkIn,
    check_out: quote.stay.checkOut,
    currency: "EUR",
    room_count: 1,
    total_amount: "360.00",
    lifecycle_status: "draft",
    booking_metadata: { pricingQuoteId: quote.quoteId },
  };
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(current.scope);
  vi.mocked(lockCurrentQuoteRevalidation).mockRejectedValue(
    new Error("own changes invalidate fresh prices"),
  );
  vi.mocked(decodeCurrentPricingQuoteRecord).mockReturnValue({ quote } as never);
});
it("consumes the exact pre-mutation discount once and replays without fresh pricing", async () => {
  const before = structuredClone(current);
  expect(await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).toEqual({
    kind: "applied",
    applicationId: "application",
    discountMinor: "2000",
    replayed: false,
  });
  expect(query.mock.lastCall?.[1]).toEqual([
    code.id,
    current.scope.propertyId,
    bookingId,
    "SAVE",
    "20",
    "EUR",
    {
      version: "booking.quote-promo.v1",
      pricingQuoteId: current.quote.quoteId,
      discountMinor: "2000",
      promoSourceRevision: "promo:1",
    },
  ]);
  expect(await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).toMatchObject({
    replayed: true,
  });
  expect(writes).toBe(1);
  expect(lockCurrentQuoteRevalidation).not.toHaveBeenCalled();
  expect(decodeCurrentPricingQuoteRecord).not.toHaveBeenCalled();
  expect(current).toEqual(before);
  expect(query.mock.calls.every(([sql]) => !/BEGIN|COMMIT|ROLLBACK/.test(sql))).toBe(true);
});
it("preserves wrapper replay before fresh revalidation and wrapper rejection of stale fresh quotes", async () => {
  await expect(
    redeemCurrentQuotePromo(client, "hotel", current.quote.quoteId, bookingId),
  ).rejects.toThrow("own changes");
  await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId);
  vi.mocked(lockCurrentQuoteRevalidation).mockClear();
  expect(
    await redeemCurrentQuotePromo(client, "hotel", current.quote.quoteId, bookingId),
  ).toMatchObject({ replayed: true });
  expect(lockCurrentQuoteRevalidation).not.toHaveBeenCalled();
  expect(writes).toBe(1);
});
it("never consumes a non-winning or absent code", async () => {
  current.calculation.discounts.codeMinor = "0";
  expect(await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).toEqual({
    kind: "not_applied",
  });
  current.calculation.code = null;
  expect(await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).toEqual({
    kind: "not_applied",
  });
  expect(writes).toBe(0);
});
it("rejects mismatched booking, replay amount, current authority and unrepresentable minor units", async () => {
  for (const patch of [
    { total_amount: "359.99" },
    { booking_metadata: null },
    { room_count: 2 },
    { lifecycle_status: "canceled" },
  ]) {
    const original = booking;
    booking = { ...booking, ...patch };
    await expect(
      redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId),
    ).rejects.toThrow("unavailable");
    booking = original;
  }
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce({
    ...current.scope,
    authorityRevision: "changed",
  });
  await expect(redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).rejects.toThrow(
    "unavailable",
  );
  current.calculation.discounts.codeMinor = "1000000000000000";
  await expect(redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).rejects.toThrow(
    "unavailable",
  );
  expect(writes).toBe(0);
  current.calculation.discounts.codeMinor = "2000";
  await redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId);
  prior[0].metadata = { ...(prior[0].metadata as object), discountMinor: "2100" };
  prior[0].discount_amount = "21";
  await expect(redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).rejects.toThrow(
    "unavailable",
  );
});
it("fails if the atomic owner update returns no consumption", async () => {
  query
    .mockImplementationOnce(async () => ({ rows: [booking] }))
    .mockImplementationOnce(async () => ({ rows: [] }))
    .mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
  await expect(redeemLockedCurrentQuotePromo(client, "hotel", current, bookingId)).rejects.toThrow(
    "unavailable",
  );
});
