import { describe, expect, it } from "vitest";

import { hotelFirstRunState, type HotelFirstRunFacts } from "./hotelFirstRunState.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";

/** A hotel straight after "Your hotel": a profile, nothing else. */
const fresh: HotelFirstRunFacts = {
  propertyId,
  profile: {
    revision: 2,
    countryCode: "DE",
    timezone: "Europe/Berlin",
    city: "Munich",
    localityPublic: false,
  },
  currency: null,
  roomTypes: [],
  payments: { payAtPropertySelected: false, currencyMatches: false },
  pricing: { pricedRoomTypeIds: [], staleReasons: [] },
  calendar: { configured: false, stale: false, inventoryPrepared: false },
  guestRules: { rulesSaved: false, termsSaved: false, designSaved: false },
  plan: "none",
};

/** The same hotel after a complete first run with Commission. */
const complete: HotelFirstRunFacts = {
  ...fresh,
  profile: { ...fresh.profile!, localityPublic: true },
  currency: { code: "EUR", revision: 1 },
  roomTypes: [
    {
      roomTypeId,
      roomFactsRevision: 1,
      roomUnitsRevision: 9,
      activeUnitCount: 8,
      unlabelledUnitIds: [],
    },
  ],
  payments: { payAtPropertySelected: true, currencyMatches: true },
  pricing: { pricedRoomTypeIds: [roomTypeId], staleReasons: [] },
  calendar: { configured: true, stale: false, inventoryPrepared: true },
  guestRules: { rulesSaved: true, termsSaved: true, designSaved: true },
  plan: "commission",
};

const states = (facts: HotelFirstRunFacts) =>
  Object.fromEntries(hotelFirstRunState(facts).steps.map((current) => [current.id, current.state]));

describe("hotelFirstRunState (VAY-2247)", () => {
  it("lists the seven steps in order and starts at the currency for a fresh hotel", () => {
    const state = hotelFirstRunState(fresh);
    expect(state.contractVersion).toBe("hotel-first-run.v1");
    expect(state.defaultsVersion).toBe("hotel-first-run-defaults.v1");
    expect(state.steps.map((current) => current.id)).toEqual([
      "currency",
      "rooms",
      "payments",
      "pricing",
      "calendar",
      "guest_rules",
      "plan",
    ]);
    expect(state.nextStep).toBe("currency");
    expect(states(fresh)).toMatchObject({
      currency: "todo",
      rooms: "todo",
      calendar: "todo",
      plan: "todo",
    });
  });

  it("is done when every step is done", () => {
    const state = hotelFirstRunState(complete);
    expect(state.nextStep).toBeNull();
    expect(new Set(Object.values(states(complete)))).toEqual(new Set(["done"]));
  });

  it("resumes rooms when some units still have no label", () => {
    const facts = {
      ...complete,
      roomTypes: [{ ...complete.roomTypes[0]!, unlabelledUnitIds: ["u-7", "u-8"] }],
    };
    const state = hotelFirstRunState(facts);
    expect(state.nextStep).toBe("rooms");
    expect(state.steps[1]).toEqual({
      id: "rooms",
      state: "todo",
      blockers: ["room_units_unlabelled"],
    });
  });

  it("marks payments and pricing stale when what they depend on changed", () => {
    const facts: HotelFirstRunFacts = {
      ...complete,
      payments: { payAtPropertySelected: true, currencyMatches: false },
      pricing: { pricedRoomTypeIds: [roomTypeId], staleReasons: ["pricing_rooms_changed"] },
    };
    expect(states(facts)).toMatchObject({ payments: "stale", pricing: "stale" });
    expect(hotelFirstRunState(facts).nextStep).toBe("payments");
  });

  it("needs a price for every active room type", () => {
    const second = {
      ...complete.roomTypes[0]!,
      roomTypeId: "0b1c2d3e-4f50-4617-8899-aabbccddeeff",
    };
    expect(states({ ...complete, roomTypes: [...complete.roomTypes, second] }).pricing).toBe(
      "todo",
    );
  });

  it("blocks the calendar without a time zone, and asks to prepare availability once configured", () => {
    const noTimezone = { ...complete, profile: { ...complete.profile!, timezone: null } };
    expect(hotelFirstRunState(noTimezone).steps[4]).toEqual({
      id: "calendar",
      state: "blocked",
      blockers: ["property_timezone_missing"],
    });
    const notPrepared = {
      ...complete,
      calendar: { configured: true, stale: false, inventoryPrepared: false },
    };
    expect(hotelFirstRunState(notPrepared).steps[4]).toEqual({
      id: "calendar",
      state: "todo",
      blockers: ["inventory_not_prepared"],
    });
    expect(
      states({ ...complete, calendar: { configured: true, stale: true, inventoryPrepared: true } })
        .calendar,
    ).toBe("stale");
  });

  it("guest rules need rules, terms, the page style and the city shown (when there is a city)", () => {
    expect(
      states({ ...complete, guestRules: { ...complete.guestRules, termsSaved: false } })
        .guest_rules,
    ).toBe("todo");
    expect(
      states({ ...complete, profile: { ...complete.profile!, localityPublic: false } }).guest_rules,
    ).toBe("todo");
    expect(
      states({ ...complete, profile: { ...complete.profile!, city: null, localityPublic: false } })
        .guest_rules,
    ).toBe("done");
  });

  it("waits on Stripe for Fixed Fee without counting it as a step to redo", () => {
    const state = hotelFirstRunState({ ...complete, plan: "fixed_checkout_pending" });
    expect(state.steps[6]!.state).toBe("awaiting_checkout");
    expect(state.nextStep).toBeNull();
    expect(states({ ...complete, plan: "fixed" }).plan).toBe("done");
  });
});
