import { expect, it, vi } from "vitest";

import { createPricingGuestDisplayRateReader } from "./pricingGuestDisplayRate.js";

const propertyId = "69000000-0000-4000-8000-000000000001";

function reader(row: { base: string | null; currency: string | null } | null, rates = {}) {
  const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [] });
  const displayRates = { rates: vi.fn().mockResolvedValue(rates) };
  return {
    query,
    displayRates,
    read: () =>
      createPricingGuestDisplayRateReader({ pool: { query }, displayRates }).read(propertyId),
  };
}

it("gives the booking page's rate from the pricing currency to the currency guests see first (VAY-2390)", async () => {
  const usd = reader({ base: "EUR", currency: "USD" }, { USD: 1.16 });
  expect(await usd.read()).toEqual({ base: "EUR", currency: "USD", rate: 1.16 });
  expect(usd.query.mock.calls[0]![1]).toEqual([propertyId]);
  expect(usd.displayRates.rates).toHaveBeenCalledWith("EUR", ["USD"]);
});

it("says nothing when guests start in the pricing currency, the selector is off, or there is no rate", async () => {
  // The selector off or no Booking settings: no row.
  for (const row of [null, { base: "EUR", currency: "EUR" }, { base: "EUR", currency: null }]) {
    const none = reader(row, { USD: 1.16 });
    expect(await none.read()).toBeNull();
    expect(none.displayRates.rates).not.toHaveBeenCalled();
  }
  expect(await reader({ base: "EUR", currency: "USD" }, {}).read()).toBeNull();
  expect(await reader({ base: "EUR", currency: "USD" }, { USD: 0 }).read()).toBeNull();
});
