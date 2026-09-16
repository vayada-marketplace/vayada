import { describe, expect, it, vi } from "vitest";
import { captureChannexAlterationFinance } from "./channexAlterationFinance.js";

const id = "82000000-0000-4000-8000-000000000001";
const input = {
  propertyId: id,
  bookingId: id,
  connectionId: id,
  bindingGeneration: id,
  providerRevisionAt: "2026-09-15T00:00:00.000001Z",
  rawRevision: { data: { attributes: { channel_id: id } } },
  revisionScope: {
    revisionId: "revision-1",
    providerPropertyId: id,
    providerBookingId: id,
    currency: "EUR",
    checkIn: "2026-09-20",
    checkOut: "2026-09-21",
    rooms: [{ providerRoomTypeId: id, roomTypeId: id }],
  },
};

describe("Airbnb financial settings evidence boundary", () => {
  it.each([
    "propertyId",
    "connectionId",
    "bindingGeneration",
    "providerPropertyId",
    "providerBookingId",
    "providerChannelId",
    "providerRevisionId",
    "providerRevisionAt",
  ] as const)("rejects evidence for a different %s before accessing Finance", async (key) => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      captureChannexAlterationFinance({ query }, input, async (_client, identity) => ({
        ...identity,
        [key]: "different",
        reference: "verified-receipt",
        booking_amount_settings: "Payout Amount",
        cohost_payout_calculations: false,
      })),
    ).rejects.toThrow("alteration_finance_settings_unavailable");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unavailable evidence before accessing Finance", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      captureChannexAlterationFinance({ query }, input, async () => null),
    ).rejects.toThrow("alteration_finance_settings_unavailable");
    expect(query).not.toHaveBeenCalled();
  });
});
