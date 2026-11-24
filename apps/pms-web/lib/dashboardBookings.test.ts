import { describe, expect, it } from "vitest";

import type { Booking } from "@/services/bookings";
import {
  addPropertyDays,
  canSeeDashboardFinance,
  formatPropertyDate,
  getArrivalsToday,
  getDashboardOccupancy,
  getDeparturesToday,
  getMonthToDateRevenue,
  getPropertyToday,
} from "./dashboardBookings";

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-1",
    checkIn: "2026-06-24",
    checkOut: "2026-06-25",
    status: "confirmed",
    checkedInAt: null,
    ...overrides,
  } as Booking;
}

describe("dashboard booking dates", () => {
  const today = "2026-06-24";

  it("classifies arrivals and departures by their matching stay date", () => {
    const arrival = booking();
    const departure = booking({
      id: "booking-2",
      checkIn: "2026-06-23",
      checkOut: today,
    });

    expect(getArrivalsToday([arrival, departure], today)).toEqual([arrival]);
    expect(getDeparturesToday([arrival, departure], today)).toEqual([departure]);
  });

  it("includes a supported same-day stay in both lists", () => {
    const sameDay = booking({ checkOut: today });

    expect(getArrivalsToday([sameDay], today)).toEqual([sameDay]);
    expect(getDeparturesToday([sameDay], today)).toEqual([sameDay]);
  });

  it.each(["cancelled", "declined", "expired"] as const)(
    "excludes %s bookings from both lists",
    (status) => {
      const excluded = booking({ checkOut: today, status });

      expect(getArrivalsToday([excluded], today)).toEqual([]);
      expect(getDeparturesToday([excluded], today)).toEqual([]);
    },
  );

  it("keeps a confirmed arrival visible until check-in", () => {
    const confirmed = booking();
    const completed = booking({ id: "booking-2", checkedInAt: "2026-06-24T14:00:00Z" });

    expect(getArrivalsToday([confirmed, completed], today)).toEqual([confirmed]);
  });

  it.each(["checked_in", "in_house", "checked_out"] as const)(
    "removes a %s booking from arrivals after check-in completion",
    (status) => {
      expect(getArrivalsToday([booking({ status })], today)).toEqual([]);
    },
  );

  it("uses the property date at a UTC day boundary", () => {
    const instant = new Date("2026-06-24T17:34:00Z");

    expect(getPropertyToday("Europe/Berlin", instant)).toBe("2026-06-24");
    expect(getPropertyToday("Asia/Makassar", instant)).toBe("2026-06-25");
    expect(
      formatPropertyDate("2026-06-25", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    ).toBe("Thursday, June 25, 2026");
    expect(
      formatPropertyDate(
        "2026-06-25",
        { weekday: "long", month: "long", day: "numeric", year: "numeric" },
        "de",
      ),
    ).toBe("Donnerstag, 25. Juni 2026");
  });

  it("builds date-only forecast windows without the viewer timezone", () => {
    expect(addPropertyDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addPropertyDays("2026-03-29", 13)).toBe("2026-04-11");
  });
});

describe("dashboard occupancy", () => {
  const date = "2026-08-21";
  const inventoryDay = (totalCount: number, occupiedCount: number, blockedCount = 0) => ({
    stayDate: date,
    totalCount,
    occupiedCount,
    blockedCount,
  });

  it("counts every room of the property and shows blocked rooms apart (VAY-2563)", () => {
    // Tiga Lombok on 2026-11-19: 7 rooms, 4 occupied, 3 blocked, none free.
    const days = [
      inventoryDay(3, 2, 1),
      inventoryDay(1, 1),
      inventoryDay(2, 1, 1),
      inventoryDay(1, 0, 1),
    ];
    expect(getDashboardOccupancy(days, date)).toEqual({
      occupiedUnits: 4,
      totalUnits: 7,
      blockedUnits: 3,
      percentage: 57,
    });
  });

  it("only counts the given night", () => {
    const otherNight = { ...inventoryDay(5, 5), stayDate: "2026-08-22" };
    expect(getDashboardOccupancy([inventoryDay(2, 1), otherNight], date)).toMatchObject({
      occupiedUnits: 1,
      totalUnits: 2,
      percentage: 50,
    });
  });

  it("does not treat an inventory hold without an eligible assignment as occupied", () => {
    expect(getDashboardOccupancy([inventoryDay(1, 0)], date)).toMatchObject({
      occupiedUnits: 0,
      totalUnits: 1,
      percentage: 0,
    });
  });

  it("keeps a closed night's rooms in the count", () => {
    expect(getDashboardOccupancy([inventoryDay(2, 0)], date).percentage).toBe(0);
    expect(getDashboardOccupancy([inventoryDay(2, 2)], date).percentage).toBe(100);
  });

  it("renders a night without rooms as unavailable", () => {
    expect(getDashboardOccupancy([], date).percentage).toBeNull();
    expect(getDashboardOccupancy([inventoryDay(0, 0)], date).percentage).toBeNull();
  });
});

describe("month-to-date revenue", () => {
  const today = "2026-11-19";
  const stay = (overrides: Partial<Booking>) =>
    booking({
      checkIn: "2026-11-10",
      checkOut: "2026-11-12",
      currency: "IDR",
      totalAmount: 1_000,
      balanceAmount: 1_000,
      paymentStatus: "unpaid",
      amountStatus: "recorded",
      ...overrides,
    });

  it("adds the stays that arrived from the 1st through today", () => {
    const bookings = [
      stay({ id: "first", checkIn: "2026-11-01", paymentStatus: "paid", balanceAmount: 0 }),
      stay({ id: "today", checkIn: today, totalAmount: 500, balanceAmount: 500 }),
      stay({ id: "last-month", checkIn: "2026-10-31" }),
      stay({ id: "tomorrow", checkIn: "2026-11-20" }),
      stay({ id: "next-month", checkIn: "2026-12-02" }),
    ];
    expect(getMonthToDateRevenue(bookings, today, "IDR")).toEqual({
      total: 1_500,
      pending: 500,
      unverified: 0,
      otherCurrencies: false,
    });
  });

  it("leaves out cancelled, declined and unconfirmed stays", () => {
    const bookings = [
      stay({ id: "kept", status: "checked_out", paymentStatus: "paid", balanceAmount: 0 }),
      stay({ id: "cancelled", status: "cancelled" }),
      stay({ id: "declined", status: "declined" }),
      stay({ id: "pending", status: "pending" }),
    ];
    expect(getMonthToDateRevenue(bookings, today, "IDR")).toMatchObject({
      total: 1_000,
      pending: 0,
    });
  });

  it("shows an unverified Airbnb amount as a part of the total instead of hiding it", () => {
    const bookings = [
      stay({ id: "paid", paymentStatus: "paid", balanceAmount: 0 }),
      stay({ id: "deposit", paymentStatus: "partially_paid", balanceAmount: 400 }),
      stay({ id: "airbnb", amountStatus: "unverified", totalAmount: 2_000, balanceAmount: 2_000 }),
    ];
    expect(getMonthToDateRevenue(bookings, today, "IDR")).toEqual({
      total: 4_000,
      pending: 400,
      unverified: 2_000,
      otherCurrencies: false,
    });
  });

  it("adds only the hotel currency and says when another one was left out", () => {
    const bookings = [stay({ id: "idr" }), stay({ id: "eur", currency: "EUR", totalAmount: 90 })];
    expect(getMonthToDateRevenue(bookings, today, "IDR")).toMatchObject({
      total: 1_000,
      otherCurrencies: true,
    });
  });
});

describe("canSeeDashboardFinance", () => {
  it.each([
    ["owner", ["pms.dashboard.read", "pms.dashboard.finance.read", "pms.finance.read"], true],
    [
      "front desk",
      ["pms.dashboard.read", "pms.dashboard.operations.read", "pms.reservation.read"],
      false,
    ],
    ["housekeeping", ["pms.dashboard.read", "pms.calendar.read", "pms.room_status.read"], false],
    [
      "reservation manager",
      ["pms.dashboard.read", "pms.reservation.read", "pms.finance.read"],
      false,
    ],
  ])("%s", (_role, permissions, expected) => {
    expect(canSeeDashboardFinance(permissions)).toBe(expected);
  });
});
