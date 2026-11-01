import { describe, expect, it } from "vitest";

import type { BookingAddon } from "@/services/bookings";
import { addonHasQuantity, addonSelection, partyOf } from "./manualBookingAddons";

const addon = (patch: Partial<BookingAddon>): BookingAddon => ({
  id: "addon",
  name: "Extra",
  description: "",
  price: 10,
  currency: "EUR",
  category: "other",
  perPerson: false,
  perNight: false,
  ...patch,
});
const stay = (checkIn: string, checkOut: string, adults: number, children = 0) => ({
  checkIn,
  checkOut,
  adults,
  children,
});
const pick = (patch: Partial<{ quantity: number; pickup: boolean; dropOff: boolean }> = {}) => ({
  quantity: 1,
  pickup: false,
  dropOff: false,
  ...patch,
});
// Two rooms on the same nights: 3 + 2 guests.
const together = [stay("2026-09-10", "2026-09-12", 2, 1), stay("2026-09-10", "2026-09-12", 2)];
// A room move: the same 2 guests, one night in each room.
const moved = [stay("2026-09-10", "2026-09-11", 2), stay("2026-09-11", "2026-09-12", 2)];

describe("partyOf", () => {
  it("counts the busiest night, so a room move doesn't double the party", () => {
    expect(partyOf(together)).toMatchObject({
      size: 5,
      arrival: "2026-09-10",
      departure: "2026-09-12",
    });
    expect(partyOf(moved).size).toBe(2);
    expect(partyOf([stay("", "", 2)])).toMatchObject({ size: 0, arrival: null, departure: null });
  });
});

describe("addonSelection", () => {
  const transfer = addon({ category: "transport", maxGuests: 4 });

  it("sends nothing until something is picked", () => {
    expect(addonSelection(transfer, undefined, together)).toBeNull();
    expect(addonSelection(transfer, pick(), together)).toBeNull();
    expect(addonSelection(transfer, pick({ pickup: true }), [stay("", "", 2)])).toBeNull();
  });

  it("dates a transfer's trips and takes enough vehicles for the busiest one", () => {
    expect(addonSelection(transfer, pick({ pickup: true, dropOff: true }), together)).toEqual({
      addonId: "addon",
      packageCount: 2,
      serviceUnits: [
        { serviceDate: "2026-09-10", guestCount: null },
        { serviceDate: "2026-09-12", guestCount: null },
      ],
    });
    expect(addonSelection(transfer, pick({ dropOff: true }), moved)).toEqual({
      addonId: "addon",
      packageCount: 1,
      serviceUnits: [{ serviceDate: "2026-09-12", guestCount: null }],
    });
    // Without a group size staff pick how many, up to the extra's own limit.
    const plain = addon({ category: "transport", maxQuantity: 2 });
    expect(addonSelection(plain, pick({ pickup: true, quantity: 9 }), together)?.packageCount).toBe(
      2,
    );
    expect(addonHasQuantity(plain)).toBe(true);
    expect(addonHasQuantity(transfer)).toBe(false);
  });

  it("charges a per-guest transfer for the guests arriving or leaving that day", () => {
    const shuttle = addon({ category: "transport", perPerson: true });
    const staggered = [stay("2026-09-10", "2026-09-12", 2), stay("2026-09-11", "2026-09-13", 3)];
    expect(addonSelection(shuttle, pick({ pickup: true, dropOff: true }), staggered)).toEqual({
      addonId: "addon",
      packageCount: 1,
      serviceUnits: [
        { serviceDate: "2026-09-10", guestCount: 2 },
        { serviceDate: "2026-09-13", guestCount: 3 },
      ],
    });
  });

  it("prices per-guest extras by the guests of each night, one package", () => {
    const breakfast = addon({ category: "meal", perPerson: true, perNight: true, maxQuantity: 5 });
    expect(addonSelection(breakfast, pick({ quantity: 4 }), moved)).toEqual({
      addonId: "addon",
      packageCount: 1,
      serviceUnits: [
        { serviceDate: "2026-09-10", guestCount: 2 },
        { serviceDate: "2026-09-11", guestCount: 2 },
      ],
    });
    const welcome = addon({ perPerson: true });
    expect(addonSelection(welcome, pick(), moved)?.serviceUnits).toEqual([
      { serviceDate: null, guestCount: 2 },
    ]);
  });

  it("counts vehicles for any transport extra with a group size, as the server does", () => {
    const scooter = addon({ category: "transport", perNight: true, maxGuests: 2, maxQuantity: 1 });
    expect(addonSelection(scooter, pick({ quantity: 1 }), together)).toEqual({
      addonId: "addon",
      packageCount: 3,
      serviceUnits: [
        { serviceDate: "2026-09-10", guestCount: null },
        { serviceDate: "2026-09-11", guestCount: null },
      ],
    });
    expect(addonHasQuantity(scooter)).toBe(false);
  });

  it("keeps other extras within their own limit, 1 when unset", () => {
    const parking = addon({ perNight: true, maxQuantity: 2 });
    expect(addonSelection(parking, pick({ quantity: 5 }), together)).toEqual({
      addonId: "addon",
      packageCount: 2,
      serviceUnits: [
        { serviceDate: "2026-09-10", guestCount: null },
        { serviceDate: "2026-09-11", guestCount: null },
      ],
    });
    expect(addonSelection(addon({}), pick({ quantity: 3 }), together)).toEqual({
      addonId: "addon",
      packageCount: 1,
      serviceUnits: [{ serviceDate: null, guestCount: null }],
    });
  });
});
