import { expect, it } from "vitest";
import { loadCurrentPricingAcceptance } from "./pricingAcceptanceAmendments.js";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const amendedQuoteId = "20000000-0000-4000-8000-000000000009";

function client(acceptance: unknown, amendment?: Record<string, unknown>) {
  const queries: string[] = [];
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: sql.includes("pricing_acceptance_amendments")
          ? amendment
            ? [amendment]
            : []
          : acceptance
            ? [acceptance]
            : [],
      };
    },
  };
}

function amendment(row: ReturnType<typeof acceptanceFixture>) {
  return {
    revision: 2,
    edit_revision: 3,
    pricing_quote_id: amendedQuoteId,
    quote_snapshot: { ...structuredClone(row.quote_snapshot), quoteId: amendedQuoteId },
    inventory_reservation_bundle: structuredClone(row.inventory_reservation_bundle),
  };
}

it("is the acceptance itself until the dates change", async () => {
  const row = acceptanceFixture();
  const current = await loadCurrentPricingAcceptance(client(row) as never, {
    propertyId,
    guestBookingId: row.guest_booking_id,
  });
  expect(current).toMatchObject({
    revision: 0,
    editRevision: 0,
    pricingQuoteId: row.pricing_quote_id,
  });
  expect(current!.quote).toBe(current!.acceptance.quote);
  expect(current!.reservation).toBe(current!.acceptance.reservation);
});

it("uses the latest amendment's quote and holds, keeping the accepted consent", async () => {
  const row = acceptanceFixture();
  const db = client(row, amendment(row));
  const current = await loadCurrentPricingAcceptance(db as never, {
    propertyId,
    guestBookingId: row.guest_booking_id,
  });
  expect(current).toMatchObject({ revision: 2, editRevision: 3, pricingQuoteId: amendedQuoteId });
  expect(current!.quote.quoteId).toBe(amendedQuoteId);
  expect(current!.acceptance.quote.quoteId).toBe(row.pricing_quote_id);
  expect(db.queries[1]).toContain("ORDER BY revision DESC");
});

it("refuses a missing acceptance or an amendment that doesn't decode", async () => {
  const row = acceptanceFixture();
  const read = (acceptance: unknown, patch?: Record<string, unknown>) =>
    loadCurrentPricingAcceptance(
      client(acceptance, patch && { ...amendment(row), ...patch }) as never,
      { propertyId, guestBookingId: row.guest_booking_id },
    );
  expect(await read(undefined)).toBeNull();
  expect(await read({ ...row, property_id: row.organization_id })).toBeNull();
  for (const patch of [
    { pricing_quote_id: "20000000-0000-4000-8000-000000000008" },
    { quote_snapshot: {} },
    { inventory_reservation_bundle: { contractVersion: "other" } },
    { inventory_reservation_bundle: { ...row.inventory_reservation_bundle, extra: true } },
    { revision: "2" },
  ])
    expect(await read(row, patch)).toBeNull();
});
