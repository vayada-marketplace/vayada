import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { reserveCurrentQuoteInventory } from "./currentQuoteInventory.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { reservePmsQuoteInventory } from "./pmsInventoryReservationLifecycleRepository.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./currentPricingQuoteStore.js", () => ({ decodeCurrentPricingQuoteRecord: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
vi.mock("./pmsInventoryReservationLifecycleRepository.js", () => ({
  reservePmsQuoteInventory: vi.fn(),
}));
const quoteId = "a1000000-0000-4000-8000-000000000001";
const scope = { propertyId: "property", organizationId: "organization", authorityRevision: "authority:1" };
const quote = {
  quoteId,
  stay: {
    propertyId: scope.propertyId,
    checkIn: "2026-10-01",
    checkOut: "2026-10-03",
    rooms: [
      { roomTypeId: "room", offerId: "flex" },
      { roomTypeId: "room", offerId: "other" },
    ],
  },
};
const query = vi.fn();
const client = { query } as unknown as PoolClient;
const held = {
  bundle: {
    contractVersion: "pms-inventory-reservation-bundle.v1" as const,
    owner: "pms" as const,
    receipts: [],
  },
  replayed: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  query.mockResolvedValue({ rows: [{ id: quoteId, payload: {} }] });
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(scope);
  vi.mocked(decodeCurrentPricingQuoteRecord).mockReturnValue({ quote } as never);
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue({ quote } as never);
  vi.mocked(reservePmsQuoteInventory).mockImplementation(async (_client, _input, fresh) => {
    await fresh();
    return held;
  });
});
it("passes only the scoped stored stay and revalidates before a fresh reservation", async () => {
  expect(await reserveCurrentQuoteInventory(client, "hotel", quoteId)).toEqual({ quote, ...held });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("organization_id=$3"), [
    quoteId,
    scope.propertyId,
    scope.organizationId,
  ]);
  expect(reservePmsQuoteInventory).toHaveBeenCalledWith(
    client,
    {
      propertyId: scope.propertyId,
      organizationId: scope.organizationId,
      quoteId,
      checkIn: quote.stay.checkIn,
      checkOut: quote.stay.checkOut,
      rooms: quote.stay.rooms,
    },
    expect.any(Function),
  );
  expect(lockCurrentQuoteRevalidation).toHaveBeenCalledWith(client, "hotel", quoteId);
  expect(lockPublicPricingAuthority).toHaveBeenCalledTimes(2);
});
it("rejects missing public authority and corrupted stored evidence", async () => {
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  await expect(reserveCurrentQuoteInventory(client, "hotel", quoteId)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  vi.mocked(decodeCurrentPricingQuoteRecord).mockReturnValueOnce(null);
  await expect(reserveCurrentQuoteInventory(client, "hotel", quoteId)).rejects.toThrow();
  expect(reservePmsQuoteInventory).not.toHaveBeenCalled();
});
it("rejects a stale fresh quote but allows PMS to replay existing held inventory", async () => {
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue(null);
  await expect(reserveCurrentQuoteInventory(client, "hotel", quoteId)).rejects.toThrow();
  vi.mocked(reservePmsQuoteInventory).mockResolvedValueOnce({ ...held, replayed: true });
  expect(await reserveCurrentQuoteInventory(client, "hotel", quoteId)).toMatchObject({
    replayed: true,
  });
  expect(lockCurrentQuoteRevalidation).toHaveBeenCalledTimes(1);
});
