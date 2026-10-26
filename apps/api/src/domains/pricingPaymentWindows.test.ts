import { describe, expect, it } from "vitest";
import { paymentWindowArrivalRange } from "./pricingPaymentWindows.js";

// 12:00 in Colombo (UTC+05:30) on 2026-10-25.
const now = new Date("2026-10-25T06:30:00.000Z");
const colombo = (checkInTime: string | null) => ({ timeZone: "Asia/Colombo", checkInTime });

describe("booking window arrival dates for /book (VAY-2348)", () => {
  it("gives the first arrival date an 'at least' window allows, counted to the check-in time", () => {
    const week = { kind: "at_least", amount: 7, unit: "days" } as const;
    // Check-in at 14:00: 1 Nov 14:00 is 7 days and 2 hours away.
    expect(paymentWindowArrivalRange(week, colombo("14:00"), now)).toEqual({ from: "2026-11-01" });
    // Check-in at 10:00: 1 Nov 10:00 is 2 hours short of a week.
    expect(paymentWindowArrivalRange(week, colombo("10:00"), now)).toEqual({ from: "2026-11-02" });
    // No check-in time: the arrival day starts at 00:00.
    expect(paymentWindowArrivalRange(week, colombo(null), now)).toEqual({ from: "2026-11-02" });
  });

  it("gives the last arrival date a 'within' window allows", () => {
    const twoDays = { kind: "within", amount: 48, unit: "hours" } as const;
    // 27 Oct 14:00 is 50 hours away; 26 Oct 14:00 is 26 hours away.
    expect(paymentWindowArrivalRange(twoDays, colombo("14:00"), now)).toEqual({
      through: "2026-10-26",
    });
    // 27 Oct 10:00 is 46 hours away.
    expect(paymentWindowArrivalRange(twoDays, colombo("10:00"), now)).toEqual({
      through: "2026-10-27",
    });
    // Within one hour of a 14:00 check-in: only after 13:00 today, so no arrival from today on.
    expect(
      paymentWindowArrivalRange(
        { kind: "within", amount: 1, unit: "hours" },
        colombo("14:00"),
        now,
      ),
    ).toEqual({ through: "2026-10-24" });
  });

  it("follows the property's own clock across a daylight-saving change", () => {
    // Berlin leaves summer time at 03:00 on 25 Oct 2026; now is 23:30 on 24 Oct there.
    const berlin = { timeZone: "Europe/Berlin", checkInTime: "15:00" };
    const late = new Date("2026-10-24T21:30:00.000Z");
    // 27 Oct 15:00 CET is 14:00Z: 64.5 hours away.
    expect(
      paymentWindowArrivalRange({ kind: "at_least", amount: 3, unit: "days" }, berlin, late),
    ).toEqual({ from: "2026-10-28" });
    expect(
      paymentWindowArrivalRange({ kind: "within", amount: 65, unit: "hours" }, berlin, late),
    ).toEqual({ through: "2026-10-27" });
  });

  it("answers null for an unknown time zone", () => {
    expect(
      paymentWindowArrivalRange(
        { kind: "at_least", amount: 3, unit: "days" },
        { timeZone: "Not/AZone", checkInTime: null },
        now,
      ),
    ).toBeNull();
  });
});
