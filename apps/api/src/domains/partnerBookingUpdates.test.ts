import { describe, expect, it } from "vitest";

import { partnerBookingSnapshot, partnerEventType, snapshotHash } from "./partnerBookingUpdates.js";

type Row = Parameters<typeof partnerBookingSnapshot>[0];

const row = (overrides: Partial<Row> = {}): Row => ({
  bookingId: "b1",
  appId: "a1",
  propertyId: "p1",
  reference: "VAY-8F3K2",
  lifecycleStatus: "confirmed",
  noShow: false,
  promoCode: "MIA10",
  promoCodeId: "c1",
  discountAmount: "46.67",
  checkIn: "2026-12-01",
  checkOut: "2026-12-04",
  roomCount: 1,
  currency: "EUR",
  totalAmount: "420.00",
  addonsAmount: "30.00",
  feesMinor: null,
  confirmedAt: new Date("2026-11-05T18:22:00Z"),
  cancelledAt: null,
  createdAt: new Date("2026-11-05T18:20:00Z"),
  updatedAt: new Date("2026-11-05T18:22:00Z"),
  sentHash: null,
  ...overrides,
});

describe("partner booking updates (VAY-2438)", () => {
  it("describes a confirmed booking as the contract shows it", () => {
    expect(partnerBookingSnapshot(row())).toEqual({
      bookingId: "b1",
      reference: "VAY-8F3K2",
      status: "confirmed",
      promoCode: "MIA10",
      promoCodeId: "c1",
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      roomCount: 1,
      currency: "EUR",
      totalAmount: "420.00",
      extrasAmount: "30.00",
      discountAmount: "46.67",
      confirmedAt: "2026-11-05T18:22:00.000Z",
      cancelledAt: null,
    });
  });

  it("counts required fees from the quote as extras, in the currency's minor units", () => {
    expect(partnerBookingSnapshot(row({ feesMinor: "1550" }))?.extrasAmount).toBe("45.50");
    expect(
      partnerBookingSnapshot(
        // IDR keeps its ISO scale (2): 5,000,000 minor units are Rp 50,000.
        row({
          currency: "IDR",
          totalAmount: "1500000.00",
          addonsAmount: "0",
          feesMinor: "5000000",
        }),
      ),
    ).toMatchObject({ totalAmount: "1500000.00", extrasAmount: "50000.00" });
  });

  it("reports cancelled and no-show bookings, and never a booking that wasn't confirmed", () => {
    expect(
      partnerBookingSnapshot(
        row({ lifecycleStatus: "canceled", cancelledAt: new Date("2026-12-02T09:14:00Z") }),
      ),
    ).toMatchObject({ status: "cancelled", cancelledAt: "2026-12-02T09:14:00.000Z" });
    expect(partnerBookingSnapshot(row({ noShow: true }))?.status).toBe("no_show");
    for (const lifecycleStatus of ["draft", "pending_payment", "declined", "expired"])
      expect(partnerBookingSnapshot(row({ lifecycleStatus, confirmedAt: null }))).toBeNull();
    // Cancelled before it was ever confirmed: not reported.
    expect(
      partnerBookingSnapshot(row({ lifecycleStatus: "canceled", confirmedAt: null })),
    ).toBeNull();
  });

  it("drops the discount when the code was taken off", () => {
    expect(
      partnerBookingSnapshot(row({ promoCode: null, promoCodeId: null, discountAmount: null })),
    ).toMatchObject({ promoCode: null, promoCodeId: null, discountAmount: "0.00" });
  });

  it("names the event by how the status moved", () => {
    expect(partnerEventType(null, "confirmed")).toBe("booking.confirmed");
    expect(partnerEventType(null, "cancelled")).toBe("booking.cancelled");
    expect(partnerEventType("confirmed", "confirmed")).toBe("booking.changed");
    expect(partnerEventType("confirmed", "cancelled")).toBe("booking.cancelled");
    expect(partnerEventType("confirmed", "no_show")).toBe("booking.no_show");
    expect(partnerEventType("no_show", "confirmed")).toBe("booking.confirmed");
  });

  it("hashes the same booking the same way and any change differently", () => {
    const snapshot = partnerBookingSnapshot(row())!;
    expect(snapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotHash({ ...snapshot })).toBe(snapshotHash(snapshot));
    expect(snapshotHash({ ...snapshot, checkOut: "2026-12-05" })).not.toBe(snapshotHash(snapshot));
  });
});
