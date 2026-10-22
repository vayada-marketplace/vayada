import { describe, expect, it } from "vitest";
import { groupReference, paymentLine } from "./confirmationDisplay";

describe("booking reference grouping", () => {
  it("groups a long reference in fours and leaves short ones alone", () => {
    expect(groupReference("VAY-7C2F4A9E1B3D4F6A8C0E2B4D6F8A1C3E")).toBe(
      "VAY-7C2F 4A9E 1B3D 4F6A 8C0E 2B4D 6F8A 1C3E",
    );
    expect(groupReference("VAY-123456789")).toBe("VAY-1234 5678 9");
    expect(groupReference("VAY-1268")).toBe("VAY-1268");
    expect(groupReference("B-CHANGE-1")).toBe("B-CHANGE-1");
  });
});

describe("confirmation payment line", () => {
  const confirmed = { ended: false, pending: false, arrived: false };
  const cancelled = { ended: true, pending: false, arrived: false };

  it("names the card for a paid, held or refunded card booking", () => {
    expect(paymentLine({ ...confirmed, way: "card", status: "paid" })).toEqual({
      title: "paidWith",
      detail: "paidHint",
      amountLabel: null,
    });
    // The hold can be only a deposit, so the amount shown is the booking's total, not "on hold".
    expect(paymentLine({ ...confirmed, pending: true, way: "card", status: "authorized" })).toEqual(
      { title: "heldOn", detail: "heldHint", amountLabel: "total" },
    );
    expect(paymentLine({ ...cancelled, way: "card", status: "refunded" })).toEqual({
      title: "refundedTo",
      detail: "refundHint",
      amountLabel: null,
    });
  });

  it("says what is due at the hotel, and that nothing was charged once cancelled", () => {
    expect(paymentLine({ ...confirmed, way: "at_hotel", status: "unpaid" })).toEqual({
      title: "payAtHotel",
      detail: "payAtHotelHint",
      amountLabel: "dueAtHotel",
    });
    expect(paymentLine({ ...cancelled, way: "at_hotel", status: "unpaid" })).toEqual({
      title: "nothingCharged",
      detail: "wasPayAtHotel",
      amountLabel: null,
    });
    expect(paymentLine({ ...confirmed, way: "at_hotel", status: "paid" }).title).toBe(
      "paidAtHotel",
    );
    // After arrival nothing is "due at check-in" any more.
    expect(paymentLine({ ...confirmed, arrived: true, way: "at_hotel", status: "unpaid" })).toEqual(
      { title: "payAtHotel", detail: "status", amountLabel: null },
    );
  });

  it("says nothing was charged for a withdrawn card request and never claims an unknown payment", () => {
    expect(paymentLine({ ...cancelled, way: "card", status: "failed" })).toEqual({
      title: "nothingCharged",
      detail: null,
      amountLabel: null,
    });
    expect(paymentLine({ ...cancelled, way: "named", status: null }).title).toBe("method");
    expect(paymentLine({ ...cancelled, way: null, status: null }).title).toBeNull();
  });

  it("keeps a deposit and other ways to pay in their own words", () => {
    expect(paymentLine({ ...confirmed, way: "card", status: "partially_paid" }).title).toBe(
      "partlyPaidWith",
    );
    expect(paymentLine({ ...confirmed, way: "named", status: "unpaid" })).toEqual({
      title: "method",
      detail: "status",
      amountLabel: null,
    });
    expect(paymentLine({ ...confirmed, way: null, status: "waived" }).title).toBe("status");
    expect(paymentLine({ ...cancelled, way: null, status: "paid" })).toEqual({
      title: "status",
      detail: null,
      amountLabel: null,
    });
  });
});
