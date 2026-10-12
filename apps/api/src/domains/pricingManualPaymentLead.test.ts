import { describe, expect, it } from "vitest";
import {
  manualPaymentEarliestArrival,
  manualPaymentLeadTimeAllows,
  propertyLocalInstant,
} from "./pricingManualPaymentLead.js";

const colombo = { timeZone: "Asia/Colombo", checkInTime: "14:00" } as const;
const minutes = (value: number) => value * 60_000;

describe("bank-transfer and PayPal lead time (VAY-2145)", () => {
  it("finds the check-in instant in the property time zone, across a DST change", () => {
    expect(propertyLocalInstant("2026-10-14", "15:00", "Asia/Colombo")?.toISOString()).toBe(
      "2026-10-14T09:30:00.000Z",
    );
    // Berlin moves from UTC+1 to UTC+2 at 02:00 on 2026-03-29.
    expect(propertyLocalInstant("2026-03-28", "15:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-03-28T14:00:00.000Z",
    );
    expect(propertyLocalInstant("2026-03-29", "15:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-03-29T13:00:00.000Z",
    );
    expect(propertyLocalInstant("2026-02-30", "15:00", "Europe/Berlin")).toBeNull();
    expect(propertyLocalInstant("2026-03-29", "24:00", "Europe/Berlin")).toBeNull();
    expect(propertyLocalInstant("2026-03-29", "15:00", "Not/AZone")).toBeNull();
  });

  it("offers bank transfer from exactly 48 hours before check-in", () => {
    const checkIn = propertyLocalInstant("2026-10-14", "14:00", "Asia/Colombo")!.getTime();
    const allows = (now: number) =>
      manualPaymentLeadTimeAllows({
        method: "bank_transfer",
        paymentWindowHours: 48,
        checkIn: "2026-10-14",
        place: colombo,
        now: new Date(now),
      });
    expect(allows(checkIn - 48 * 3_600_000)).toBe(true);
    expect(allows(checkIn - 48 * 3_600_000 + minutes(1))).toBe(false);
  });

  it("offers PayPal only when check-in is further away than the hotel's window", () => {
    const checkIn = propertyLocalInstant("2026-10-14", "14:00", "Asia/Colombo")!.getTime();
    const allows = (now: number) =>
      manualPaymentLeadTimeAllows({
        method: "paypal",
        paymentWindowHours: 24,
        checkIn: "2026-10-14",
        place: colombo,
        now: new Date(now),
      });
    expect(allows(checkIn - 24 * 3_600_000)).toBe(false);
    expect(allows(checkIn - 24 * 3_600_000 - minutes(1))).toBe(true);
  });

  it("starts the arrival day at 00:00 without a check-in time, and refuses unknown places", () => {
    const base = {
      method: "bank_transfer",
      paymentWindowHours: 48,
      checkIn: "2026-10-14",
    } as const;
    const midnight = propertyLocalInstant("2026-10-14", "00:00", "Asia/Colombo")!.getTime();
    const place = { timeZone: "Asia/Colombo", checkInTime: null };
    expect(
      manualPaymentLeadTimeAllows({ ...base, place, now: new Date(midnight - 48 * 3_600_000) }),
    ).toBe(true);
    expect(
      manualPaymentLeadTimeAllows({
        ...base,
        place,
        now: new Date(midnight - 48 * 3_600_000 + minutes(1)),
      }),
    ).toBe(false);
    expect(
      manualPaymentLeadTimeAllows({
        ...base,
        place: { timeZone: "Not/AZone", checkInTime: "14:00" },
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    ).toBe(false);
  });

  it("names the first arrival date each method can be offered for", () => {
    // 15:30 in Colombo on 2026-10-12; check-in is at 14:00.
    const now = new Date("2026-10-12T10:00:00Z");
    expect(
      manualPaymentEarliestArrival({
        method: "bank_transfer",
        paymentWindowHours: 48,
        place: colombo,
        now,
      }),
    ).toBe("2026-10-15");
    expect(
      manualPaymentEarliestArrival({
        method: "paypal",
        paymentWindowHours: 24,
        place: colombo,
        now,
      }),
    ).toBe("2026-10-14");
    expect(
      manualPaymentEarliestArrival({
        method: "paypal",
        paymentWindowHours: 168,
        place: colombo,
        now,
      }),
    ).toBe("2026-10-20");
    expect(
      manualPaymentEarliestArrival({
        method: "paypal",
        paymentWindowHours: 24,
        place: { timeZone: "Not/AZone", checkInTime: null },
        now,
      }),
    ).toBeNull();
  });
});
