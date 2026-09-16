import { expect, it, vi } from "vitest";

import { appendMissingAddonRevenueEvidence } from "./bookingAddonRevenueEvidence.js";

it("records every active purchased add-on as explicitly missing", async () => {
  const selections = [
    {
      selectionId: "f6855600-0000-0000-0000-000000000001",
      serviceDate: "2026-08-17",
      checkIn: "2026-08-15",
      quantity: 2,
      currency: "EUR",
      totalAmount: "30.0000",
      ownershipKind: "property",
      partnerCommissionRate: null,
    },
    {
      selectionId: "f6855600-0000-0000-0000-000000000002",
      serviceDate: null,
      checkIn: "2026-08-15",
      quantity: 1,
      currency: "EUR",
      totalAmount: "50.0000",
      ownershipKind: "partner",
      partnerCommissionRate: "12.5000",
    },
  ];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    void values;
    return text.includes("FROM booking.guest_bookings booking")
      ? { rows: selections, rowCount: selections.length }
      : { rows: [], rowCount: 1 };
  });

  await appendMissingAddonRevenueEvidence({ query } as never, {
    propertyId: "property-1",
    guestBookingId: "booking-1",
    commandKey: "pms-no-show:command-hash",
  });

  const inserts = query.mock.calls.filter(([text]) =>
    text.includes("INSERT INTO booking.addon_revenue_evidence"),
  );
  expect(inserts.map(([, values]) => values?.slice(3, 11))).toEqual([
    ["2026-08-17", 2, "EUR", null, "property", null, "missing_fulfillment", "missing"],
    ["2026-08-15", 1, "EUR", null, "partner", "12.5000", "missing_fulfillment", "missing"],
  ]);
  expect(inserts.map(([, values]) => values?.[11])).toEqual([
    `pms-no-show:command-hash:addon:${selections[0]!.selectionId}:v1`,
    `pms-no-show:command-hash:addon:${selections[1]!.selectionId}:v1`,
  ]);
});
