import { describe, expect, it } from "vitest";
import type { Booking, BookingAddon } from "@/services/bookings";
import type { CheckinRoom } from "./rooms";
import { addonOffer } from "./addons";
import { deskChargeChanges, deskMethods, deskPayableBalance, settlementMethodFor } from "./payment";

const addon = (perPerson: boolean, perNight: boolean, price = 10): BookingAddon => ({
  id: `addon-${perPerson}-${perNight}`,
  name: "Extra",
  description: "",
  price,
  currency: "EUR",
  category: "",
  perPerson,
  perNight,
});
const rooms = [
  { guests: 2, nights: 2 },
  { guests: 2, nights: 4 },
] as CheckinRoom[];
const booking = { adults: 4, children: 0, nights: 4 };

describe("check-in add-ons and payment (VAY-2373)", () => {
  it("prices desk add-ons from the catalog for this stay", () => {
    // Breakfast at €8 per guest per night: 2 guests × 2 nights + 2 guests × 4 nights = 12.
    expect(addonOffer(addon(true, true, 8), booking, rooms)).toMatchObject({
      model: "per_guest_night",
      units: 12,
      amount: 96,
      byQuantity: false,
    });
    // A scooter a day for the longest stay, sold by the piece.
    expect(addonOffer(addon(false, true), booking, rooms)).toMatchObject({
      units: 4,
      amount: 40,
      byQuantity: true,
    });
    expect(addonOffer(addon(true, false), booking, rooms)).toMatchObject({ units: 4, amount: 40 });
    expect(addonOffer(addon(false, false, 25), booking, rooms)).toMatchObject({
      units: 1,
      amount: 25,
    });
  });

  it("records card as the hotel's own terminal and already paid as other", () => {
    expect(settlementMethodFor({ kind: "collect", method: "card" })).toBe("manual_card");
    expect(settlementMethodFor({ kind: "collect", method: "cash" })).toBe("cash");
    expect(settlementMethodFor({ kind: "already_paid" })).toBe("other");
    expect(settlementMethodFor({ kind: "at_checkout" })).toBeNull();
    expect(deskMethods(["cash", "at_checkout", "card"])).toEqual(["card", "cash"]);
  });

  it("knows which balances the desk can record", () => {
    const base = { amountStatus: "recorded", status: "confirmed" } as Booking;
    expect(
      deskPayableBalance({ ...base, paymentMethod: "pay_at_property", paymentStatus: "unpaid" }),
    ).toBe("atProperty");
    expect(
      deskPayableBalance({ ...base, paymentMethod: null, paymentStatus: "unpaid" }),
    ).toBeNull();
    expect(
      deskPayableBalance({ ...base, paymentMethod: "card", paymentStatus: "partially_paid" }),
    ).toBe("cardRest");
  });

  it("creates the new desk charges and waives the removed ones, never a paid one", () => {
    const breakfast = { addonId: "breakfast", label: "Breakfast", amount: 96 };
    const scooter = { addonId: "scooter", label: "Scooter rental × 2", amount: 80 };
    const created = [
      { ...breakfast, chargeId: "c1", paid: false },
      { addonId: "scooter", label: "Scooter rental", amount: 40, chargeId: "c2", paid: false },
      { addonId: "late", label: "Late check-out", amount: 20, chargeId: "c3", paid: true },
    ];
    const changes = deskChargeChanges([breakfast, scooter], created);
    expect(changes.create).toEqual([scooter]);
    expect(changes.waive.map((charge) => charge.chargeId)).toEqual(["c2"]);
  });
});
