import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: null as unknown }));
vi.mock("./publicPricingPublication.js", () => ({
  lockPublicPricingPublication: vi.fn(async () => mocks.owner),
}));
vi.mock("./publicPricingRoomStay.js", () => ({
  publicPricingOfferBindings: () => [
    { roomTypeId: "room", offerId: "nrf", publicOfferKey: "key-nrf" },
    { roomTypeId: "room", offerId: "flex", publicOfferKey: "key-flex" },
    { roomTypeId: "room", offerId: "old", publicOfferKey: "key-old" },
  ],
}));

import { selectedRatesTakePaymentMethod } from "./selectedRatePaymentMethods.js";

const terms = (offerId: string, payment: Record<string, unknown>) => ({
  roomTypeId: "room",
  offerId,
  payment,
});
const owner = {
  terms: [
    terms("nrf", { kind: "full", acceptedMethods: ["card"] }),
    terms("flex", { kind: "full", acceptedMethods: ["card", "pay_at_property"] }),
    // Rows from before VAY-2139 name no methods.
    terms("old", { kind: "full" }),
  ],
};
const client = {} as PoolClient;
const stay = (...keys: string[]) => ({
  rooms: keys.map((publicOfferKey, index) => ({
    selectionId: String(index),
    publicOfferKey,
    guests: { adults: 1, childAgesAtCheckIn: [] },
  })),
});

describe("which way to pay a refused quote's rates take (VAY-2309)", () => {
  it("names a way to pay a chosen rate's terms don't take", async () => {
    mocks.owner = owner;
    const takes = (method: "card" | "pay_at_property", ...keys: string[]) =>
      selectedRatesTakePaymentMethod(client, "hotel", stay(...keys), method);
    expect(await takes("pay_at_property", "key-nrf")).toBe(false);
    expect(await takes("card", "key-nrf")).toBe(true);
    expect(await takes("pay_at_property", "key-flex")).toBe(true);
    // One room's rate is enough to refuse the stay.
    expect(await takes("pay_at_property", "key-flex", "key-nrf")).toBe(false);
  });

  it("leaves other refusals unnamed", async () => {
    mocks.owner = owner;
    for (const key of ["key-old", "pricing-offer.v2:unknown"])
      expect(await selectedRatesTakePaymentMethod(client, "hotel", stay(key), "card")).toBe(true);
    mocks.owner = null;
    expect(
      await selectedRatesTakePaymentMethod(client, "hotel", stay("key-nrf"), "pay_at_property"),
    ).toBe(true);
  });
});
