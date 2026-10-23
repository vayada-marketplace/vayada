/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import type { PricingOffer } from "@/services/api/replacementOffers";
import {
  combinable,
  decodePicks,
  encodePick,
  readPickDraft,
  savePickDraft,
  splitParty,
  type RoomPick,
} from "./roomPicker";

const KEY = `pricing-offer.v2:${"a".repeat(64)}`;
const offer = (patch: Partial<PricingOffer>): PricingOffer => ({
  publicOfferKey: KEY,
  currency: "EUR",
  mealPlan: "room_only",
  ...patch,
});

describe("splitParty", () => {
  it("spreads adults evenly and puts children with the fewest adults, last rooms first", () => {
    expect(splitParty(3, 1, 2)).toEqual([
      { adults: 2, children: 0 },
      { adults: 1, children: 1 },
    ]);
    expect(splitParty(4, 3, 2)).toEqual([
      { adults: 2, children: 1 },
      { adults: 2, children: 2 },
    ]);
    expect(splitParty(2, 0, 1)).toEqual([{ adults: 2, children: 0 }]);
  });

  it("never gives a room no adult", () => {
    expect(splitParty(2, 2, 5)).toEqual([
      { adults: 1, children: 1 },
      { adults: 1, children: 1 },
    ]);
  });
});

describe("combinable", () => {
  const full = { kind: "full" } as const;
  const deposit = (key: string) => ({ kind: "deposit", percent: 30, key }) as const;

  it("joins rates paid the same way that share a way to pay", () => {
    expect(
      combinable(offer({ paymentSchedule: full, paymentMethods: ["card", "pay_at_property"] }), [
        offer({ paymentSchedule: full, paymentMethods: ["card"] }),
      ]),
    ).toBe("ok");
    expect(
      combinable(offer({ paymentSchedule: deposit("d:30") }), [
        offer({ paymentSchedule: deposit("d:30") }),
      ]),
    ).toBe("ok");
  });

  it("refuses a rate paid on another schedule or with no shared way to pay", () => {
    expect(
      combinable(offer({ paymentSchedule: full }), [offer({ paymentSchedule: deposit("d:30") })]),
    ).toBe("paid_differently");
    expect(
      combinable(offer({ paymentSchedule: deposit("d:50") }), [
        offer({ paymentSchedule: deposit("d:30") }),
      ]),
    ).toBe("paid_differently");
    expect(
      combinable(offer({ paymentMethods: ["pay_at_property"] }), [
        offer({ paymentMethods: ["card"] }),
      ]),
    ).toBe("paid_differently");
  });

  it("leaves unknown schedules and methods to the quote", () => {
    expect(combinable(offer({}), [offer({ paymentSchedule: full })])).toBe("ok");
    expect(combinable(offer({ paymentMethods: ["card"] }), [offer({})])).toBe("ok");
    expect(combinable(offer({}), [])).toBe("ok");
  });
});

describe("picks in the /book link", () => {
  it("round-trips each room's guests and rate", () => {
    const picks = [
      { adults: 2, children: 0, publicOfferKey: KEY },
      { adults: 1, children: 1, publicOfferKey: KEY.replace("a", "b") },
    ];
    expect(decodePicks(picks.map(encodePick))).toEqual(picks);
  });

  it("refuses anything else", () => {
    for (const values of [
      [],
      ["0-0-" + KEY],
      ["2-0-other"],
      ["2-100-" + KEY],
      Array(10).fill("1-0-" + KEY),
    ])
      expect(decodePicks(values)).toBeNull();
  });
});

describe("pick drafts", () => {
  afterEach(() => sessionStorage.clear());
  const pick: RoomPick = {
    adults: 2,
    children: 0,
    roomTypeId: "room",
    publicOfferKey: KEY,
    totalMinor: "29800",
    currency: "EUR",
  };

  it("keeps a tab's picks for the same search only", () => {
    savePickDraft("hotel", "search-1", [pick, null]);
    expect(readPickDraft("hotel", "search-1")).toEqual([pick, null]);
    expect(readPickDraft("hotel", "search-2")).toBeNull();
    sessionStorage.setItem("roomPicks:hotel", JSON.stringify({ identity: "x", picks: [{}] }));
    expect(readPickDraft("hotel", "x")).toBeNull();
  });
});
