/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import type { PricingOffer, PricingRoom } from "@/services/api/replacementOffers";
import {
  combinable,
  decodePicks,
  encodePick,
  evenSplit,
  fitsRoom,
  mostRooms,
  moveAdult,
  pickIdentity,
  readPickDraft,
  roomGuestProblem,
  roomGuests,
  savePickDraft,
  saveRoomUndo,
  splitParty,
  takeRoomUndo,
  type RoomPick,
  type RoomUndo,
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

describe("who sleeps where (VAY-2393)", () => {
  it("splits adults evenly by default", () => {
    expect(evenSplit(4, 2)).toEqual([2, 2]);
    expect(evenSplit(5, 2)).toEqual([3, 2]);
    expect(evenSplit(2, 4)).toEqual([1, 1]);
  });

  it("puts children with the fewest adults of the group's own split", () => {
    expect(roomGuests([3, 1], 1)).toEqual([
      { adults: 3, children: 0 },
      { adults: 1, children: 1 },
    ]);
    expect(roomGuests([1, 3], 2)).toEqual([
      { adults: 1, children: 1 },
      { adults: 3, children: 1 },
    ]);
  });

  it("moves one adult at a time and keeps the total and an adult in every room", () => {
    expect(moveAdult([2, 2], 0, 1)).toEqual([3, 1]);
    expect(moveAdult([3, 1], 0, -1)).toEqual([2, 2]);
    expect(moveAdult([3, 1], 1, 1)).toEqual([2, 2]);
    // More in room 1 comes from the fullest other room, fewer goes to the emptiest.
    expect(moveAdult([1, 3, 2], 0, 1)).toEqual([2, 2, 2]);
    expect(moveAdult([3, 2, 1], 0, -1)).toEqual([2, 2, 2]);
    // Not possible: every other room is down to one adult, or this one is.
    expect(moveAdult([3, 1], 0, 1)).toEqual([3, 1]);
    expect(moveAdult([3, 1], 1, -1)).toEqual([3, 1]);
  });

  it("offers up to 4 rooms, more only when the group needs them, never more than adults", () => {
    expect(mostRooms(10, 1)).toBe(4);
    expect(mostRooms(3, 1)).toBe(3);
    expect(mostRooms(12, 6)).toBe(6);
    expect(mostRooms(40, 20)).toBe(9);
  });

  it("checks one room's guests against its limits like the API", () => {
    const limits = { maxGuests: 3, maxAdults: 3, maxChildren: 1 };
    expect(fitsRoom(limits, { adults: 3, children: 0 })).toBe(true);
    expect(fitsRoom(limits, { adults: 4, children: 0 })).toBe(false);
    expect(fitsRoom(limits, { adults: 2, children: 2 })).toBe(false);
    expect(fitsRoom(limits, { adults: 3, children: 1 })).toBe(false);
    expect(fitsRoom(undefined, { adults: 9, children: 0 })).toBe(true);
    expect(fitsRoom(undefined, { adults: 0, children: 1 })).toBe(false);
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
  const pick: RoomPick = { roomTypeId: "room", publicOfferKey: KEY };
  const stay = { checkIn: "2026-11-10", checkOut: "2026-11-12", promoCode: null };

  it("keeps a tab's split and picks for the same stay only", () => {
    const identity = pickIdentity(stay);
    savePickDraft("hotel", identity, { split: [3, 1], picks: [pick, null] });
    expect(readPickDraft("hotel", identity)).toEqual({ split: [3, 1], picks: [pick, null] });
    // Children the guest placed come back while they match the rooms.
    savePickDraft("hotel", identity, { split: [2, 2], picks: [pick, null], children: [0, 1] });
    expect(readPickDraft("hotel", identity)).toEqual({
      split: [2, 2],
      picks: [pick, null],
      children: [0, 1],
    });
    expect(readPickDraft("hotel", pickIdentity({ ...stay, checkOut: "2026-11-13" }))).toBeNull();
    expect(readPickDraft("hotel", pickIdentity({ ...stay, promoCode: "SUMMER" }))).toBeNull();
  });

  it("ignores a draft it can't trust", () => {
    for (const draft of [
      { identity: "x", split: [2], picks: [{}] },
      { identity: "x", split: [0, 2], picks: [] },
      { identity: "x", picks: [] },
      // VAY-2320's drafts had no split.
      { identity: "x", picks: [{ ...pick, adults: 2, children: 0 }] },
    ]) {
      sessionStorage.setItem("roomPicks:hotel", JSON.stringify(draft));
      expect(readPickDraft("hotel", "x")).toBeNull();
    }
  });
});

// VAY-2393: a room removed on the Extras step that sent the guest back to the room cards.
describe("room Undo from the Extras step", () => {
  afterEach(() => sessionStorage.clear());
  const undo: RoomUndo = {
    message: "Room 2 removed.",
    bookSearch: "?checkIn=2026-11-10&pick=x",
    identity: "stay",
    hotel: null,
    focusAction: true,
    at: 1_000_000,
  };

  it("is shown once, within 10 seconds", () => {
    saveRoomUndo("hotel", undo);
    expect(takeRoomUndo("hotel", 1_000_000 + 5000)).toEqual(undo);
    expect(takeRoomUndo("hotel", 1_000_000 + 5000)).toBeNull();
    saveRoomUndo("hotel", undo);
    expect(takeRoomUndo("hotel", 1_000_000 + 10_000)).toBeNull();
  });

  it("ignores an Undo it can't trust", () => {
    for (const bad of [{ bookSearch: "//evil.test" }, { identity: null }, { focusAction: "yes" }]) {
      saveRoomUndo("hotel", { ...undo, ...bad } as unknown as RoomUndo);
      expect(takeRoomUndo("hotel", 1_000_000)).toBeNull();
    }
  });
});

const room = (maxGuests: number, maxAdults: number, maxChildren: number): PricingRoom => ({
  roomTypeId: "room",
  name: "Room",
  offers: [],
  occupancy: { maxGuests, maxAdults, maxChildren },
});
const guests = (adults: number, childAges: string[] = []) => ({
  selectionId: "room-1",
  publicOfferKey: "key",
  adults: String(adults),
  childAges,
});

describe("roomGuestProblem", () => {
  it("accepts guests within the room's limits", () => {
    expect(roomGuestProblem(room(3, 2, 1), guests(2, ["5"]))).toBeNull();
  });

  it("names the first limit the room's guests break", () => {
    expect(roomGuestProblem(room(3, 2, 1), guests(0, ["5"]))).toBe("no_adult");
    expect(roomGuestProblem(room(2, 2, 0), guests(1, ["5"]))).toBe("no_children");
    expect(roomGuestProblem(room(2, 2, 2), guests(2, ["5"]))).toBe("too_many");
    expect(roomGuestProblem(room(3, 2, 1), guests(3))).toBe("too_many_adults");
    expect(roomGuestProblem(room(4, 3, 1), guests(1, ["5", "7"]))).toBe("too_many_children");
  });

  it("leaves a room without known limits to the quote, but still needs an adult", () => {
    expect(roomGuestProblem(undefined, guests(4, ["5"]))).toBeNull();
    expect(roomGuestProblem(undefined, guests(0))).toBe("no_adult");
  });
});
