import { parsePmsInventoryReservationBundle } from "@vayada/domain-pms";
import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { stagePricingBookingLifecycle } from "./pricingBookingLifecycle.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { reserveRevalidatedQuoteInventory } from "./currentQuoteInventory.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentQuoteInventory.js", () => ({ reserveRevalidatedQuoteInventory: vi.fn() }));
function fixture(mode: "instant" | "request" = "instant") {
  const input = pricingDraftFixture((q) => Object.assign(q, { acceptanceMode: mode }));
  const { quote, scope } = input.current;
  const now = new Date(Date.parse(quote.evidence.issuedAt) + 1000);
  const booking = {
    lifecycle_status: "draft",
    payment_status: "unpaid",
    source_system: "booking",
    booking_channel: "direct",
    direct_booking_source: "booking_engine",
    expected_payment_method: "pay_at_property",
    edit_revision: 0,
    check_in: quote.stay.checkIn,
    check_out: quote.stay.checkOut,
    currency: "EUR",
    room_count: 1,
    adults: 2,
    children: 1,
    total_amount: "360.00",
    balance_amount: "360.00",
    booking_metadata: {
      targetSource: "pricing_quote_draft",
      pricingQuoteId: quote.quoteId,
      acceptanceMode: mode,
      paymentMethod: quote.paymentMethod,
      pricingSelections: quote.stay.rooms,
      requestFingerprint: input.command.fingerprint,
    },
  };
  const bundle = parsePmsInventoryReservationBundle(
    acceptanceFixture().inventory_reservation_bundle,
  )!;
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(scope);
  vi.mocked(reserveRevalidatedQuoteInventory).mockResolvedValue({ quote, bundle, replayed: false });
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    void _values;
    if (sql.startsWith("SELECT lifecycle_status")) return { rows: [booking] };
    if (sql === "SELECT clock_timestamp() AS now") return { rows: [{ now }] };
    return { rows: [{ bookings: 1, events: 1, summaries: 1 }] };
  });
  const client = { query } as unknown as PoolClient;
  return {
    input,
    booking,
    now,
    query,
    client,
    bundle,
    run: () => stagePricingBookingLifecycle(client, "hotel", input.current, input.bookingId),
  };
}
beforeEach(() => vi.resetAllMocks());
it.each(["instant", "request"] as const)(
  "stages %s status and a database-time deadline only for requests",
  async (mode) => {
    const f = fixture(mode),
      result = await f.run();
    expect(result).toEqual({
      bookingId: f.input.bookingId,
      lifecycleStatus: mode === "instant" ? "confirmed" : "pending_payment",
      hostResponseDeadlineAt:
        mode === "instant" ? null : new Date(f.now.getTime() + 86400000).toISOString(),
      occurredAt: f.now.toISOString(),
      inventoryReservation: f.bundle,
    });
    expect(reserveRevalidatedQuoteInventory).toHaveBeenCalledWith(
      f.client,
      "hotel",
      f.input.current,
    );
    const [sql, values] = f.query.mock.calls.find(([sql]) => sql.startsWith("WITH changed"))!;
    expect(sql).toContain("booking.booking_status_events");
    expect(sql).toContain("booking.direct_booking_summary_read_model");
    expect(values?.[4]).toEqual({
      inventoryReservation: f.bundle,
      ...(result.hostResponseDeadlineAt
        ? { hostResponseDeadlineAt: result.hostResponseDeadlineAt }
        : {}),
    });
    expect(sql).not.toMatch(/COMMIT|ROLLBACK|platform.jobs|checkout_contexts|quote_sessions/);
  },
);
it.each([
  "scope",
  "missing-mode",
  "payment",
  "booking-status",
  "paid",
  "revision",
  "amount",
  "balance",
  "stay",
  "mode",
  "selection",
  "deadline",
  "inventory",
])("rejects changed %s before reserving inventory", async (kind) => {
  const f = fixture();
  if (kind === "scope") vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  if (kind === "missing-mode") Reflect.deleteProperty(f.input.current.quote, "acceptanceMode");
  if (kind === "payment") Object.assign(f.input.current.quote, { paymentMethod: "card" });
  if (kind === "booking-status") f.booking.lifecycle_status = "confirmed";
  if (kind === "paid") f.booking.payment_status = "paid";
  if (kind === "revision") f.booking.edit_revision = 1;
  if (kind === "amount") f.booking.total_amount = "359.99";
  if (kind === "balance") f.booking.balance_amount = "0.00";
  if (kind === "stay") f.booking.check_out = "2026-10-04";
  if (kind === "mode") f.booking.booking_metadata.acceptanceMode = "request";
  if (kind === "selection") Object.assign(f.booking.booking_metadata, { pricingSelections: [] });
  if (kind === "deadline")
    Object.assign(f.booking.booking_metadata, { hostResponseDeadlineAt: f.now.toISOString() });
  if (kind === "inventory")
    Object.assign(f.booking.booking_metadata, { inventoryReservation: f.bundle });
  await expect(f.run()).rejects.toThrow("unavailable");
  expect(reserveRevalidatedQuoteInventory).not.toHaveBeenCalled();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("WITH changed"))).toBe(false);
});
it("rejects expiry reached after the inventory wait without writing lifecycle", async () => {
  const f = fixture();
  f.now.setTime(Date.parse(f.input.current.quote.evidence.expiresAt));
  await expect(f.run()).rejects.toThrow("unavailable");
  expect(reserveRevalidatedQuoteInventory).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("WITH changed"))).toBe(false);
});
it("propagates inventory failure, database write failure and late authority loss for full rollback", async () => {
  const f = fixture();
  vi.mocked(reserveRevalidatedQuoteInventory).mockRejectedValueOnce(new Error("inventory failure"));
  await expect(f.run()).rejects.toThrow("inventory failure");
  const implementation = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (sql.startsWith("WITH changed")) throw new Error("database failure");
    return implementation(sql, values);
  });
  await expect(f.run()).rejects.toThrow("database failure");
  f.query.mockImplementation(implementation);
  vi.mocked(lockPublicPricingAuthority)
    .mockResolvedValueOnce(f.input.current.scope)
    .mockResolvedValueOnce(f.input.current.scope)
    .mockResolvedValueOnce(null);
  await expect(f.run()).rejects.toThrow("unavailable");
});
