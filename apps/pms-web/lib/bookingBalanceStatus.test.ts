import { describe, expect, it } from "vitest";
import { getBalanceStatus } from "./bookingBalanceStatus";

const unpaid = {
  amountStatus: "recorded" as const,
  status: "confirmed" as const,
  paymentStatus: null,
  depositRequired: false,
  depositAmount: 0,
  balanceAmount: 200,
};

describe("getBalanceStatus", () => {
  it("shows Due only while a booking is still open", () => {
    expect(getBalanceStatus(unpaid)).toBe("due");
    // A cancelled pay-at-property booking owes nothing: PMS cancellations retain no charges (VAY-2089).
    for (const status of ["cancelled", "declined", "expired"] as const) {
      expect(getBalanceStatus({ ...unpaid, status })).toBe("closed");
      expect(getBalanceStatus({ ...unpaid, status, paymentStatus: "refunded" })).toBe("refunded");
      expect(getBalanceStatus({ ...unpaid, status, paymentStatus: "paid" })).toBe("paid");
    }
    expect(getBalanceStatus({ ...unpaid, status: "no_show" })).toBe("due");
    // The booking read reports "paid" (not the older "captured") for a settled booking.
    expect(getBalanceStatus({ ...unpaid, paymentStatus: "paid" })).toBe("paid");
    expect(getBalanceStatus({ ...unpaid, paymentStatus: "partially_paid" })).toBe("partial");
  });

  it("keeps unverified amounts and deposits ahead of the closed state", () => {
    expect(getBalanceStatus({ ...unpaid, status: "cancelled", amountStatus: "unverified" })).toBe(
      "unverified",
    );
    // prettier-ignore
    expect(getBalanceStatus({ ...unpaid, depositRequired: true, depositAmount: 50, paymentStatus: "captured" })).toBe("partial");
    expect(getBalanceStatus({ ...unpaid, paymentStatus: "authorized" })).toBe("partial");
  });
});
