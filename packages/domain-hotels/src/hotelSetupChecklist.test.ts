import { describe, expect, it } from "vitest";

import {
  HOTEL_SETUP_CHECKLIST_ITEMS,
  buildHotelSetupChecklist,
  parseHotelSetupChecklist,
  type HotelSetupChecklistFacts,
} from "./hotelSetupChecklist.js";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

/** A hotel that just went live through the first run (Paper rev 4 c01-1: 4 of 9 done). */
const LIVE: HotelSetupChecklistFacts = {
  propertyId: PROPERTY,
  nextSetupStep: null,
  hotelBasics: true,
  firstRoom: true,
  guestPayment: true,
  bookingPublished: true,
  photos: false,
  style: false,
  calendar: "default",
  guestTerms: "default",
  onlineCardReady: false,
  onlineCardsOffered: false,
  viewer: { hidden: false, dismissed: false },
};

const states = (facts: HotelSetupChecklistFacts) =>
  Object.fromEntries(buildHotelSetupChecklist(facts).items.map((item) => [item.id, item.state]));

describe("hotel setup checklist (VAY-2247 wave 2)", () => {
  it("shows a hotel that just went live with 4 of 9 done and setup's defaults in use", () => {
    const checklist = buildHotelSetupChecklist(LIVE);
    expect(checklist).toMatchObject({
      contractVersion: "hotel-setup-checklist.v1",
      propertyId: PROPERTY,
      phase: "live",
      setup: { done: 5, total: 5, next: null },
      done: 4,
      total: 9,
    });
    expect(checklist.items.map((item) => item.id)).toEqual([...HOTEL_SETUP_CHECKLIST_ITEMS]);
    expect(states(LIVE)).toEqual({
      hotel_basics: "done",
      first_room: "done",
      guest_payment: "done",
      booking_published: "done",
      photos: "todo",
      style: "default_in_use",
      calendar: "default_in_use",
      guest_terms: "default_in_use",
      online_cards: "later",
    });
  });

  it("counts Looks good and changes as done (c01-2: 5 of 9)", () => {
    expect(buildHotelSetupChecklist({ ...LIVE, calendar: "acknowledged" }).done).toBe(5);
    expect(states({ ...LIVE, guestTerms: "changed", style: true, photos: true })).toMatchObject({
      guest_terms: "done",
      style: "done",
      photos: "done",
    });
  });

  it("offers online cards as a to-do once they exist, and done once Stripe is ready", () => {
    expect(states({ ...LIVE, onlineCardsOffered: true }).online_cards).toBe("todo");
    expect(states({ ...LIVE, onlineCardReady: true }).online_cards).toBe("done");
  });

  it("is complete when all nine are done", () => {
    const all = buildHotelSetupChecklist({
      ...LIVE,
      photos: true,
      style: true,
      calendar: "acknowledged",
      guestTerms: "acknowledged",
      onlineCardReady: true,
    });
    expect(all).toMatchObject({ phase: "complete", done: 9, total: 9 });
  });

  it("follows the setup screens before the page is published (c01-0: 2 of 5 steps in)", () => {
    const setup = buildHotelSetupChecklist({
      ...LIVE,
      nextSetupStep: "first_room",
      firstRoom: false,
      guestPayment: false,
      bookingPublished: false,
    });
    expect(setup).toMatchObject({
      phase: "setup",
      setup: { done: 2, total: 5, next: "first_room" },
    });
    // Everything saved but not yet published: Go live is next.
    expect(
      buildHotelSetupChecklist({ ...LIVE, nextSetupStep: null, bookingPublished: false }).setup,
    ).toEqual({ done: 4, total: 5, next: "go_live" });
  });

  it("carries the signed-in person's own Hide for now and Dismiss", () => {
    expect(
      buildHotelSetupChecklist({ ...LIVE, viewer: { hidden: true, dismissed: false } }).viewer,
    ).toEqual({ hidden: true, dismissed: false });
  });
});

describe("parseHotelSetupChecklist", () => {
  const built = buildHotelSetupChecklist(LIVE);

  it("reads what the builder makes", () => {
    expect(parseHotelSetupChecklist(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it("leaves out items and states it doesn't know, keeping the server's counts", () => {
    const newer = {
      ...JSON.parse(JSON.stringify(built)),
      items: [
        ...built.items.map((item) =>
          item.id === "photos" ? { ...item, state: "reviewing" } : item,
        ),
        { id: "reviews", state: "todo" },
      ],
      done: 4,
      total: 10,
      extra: { future: true },
    };
    const parsed = parseHotelSetupChecklist(newer);
    expect(parsed?.items.map((item) => item.id)).not.toContain("photos");
    expect(parsed?.items.map((item) => item.id)).not.toContain("reviews");
    expect(parsed).toMatchObject({ done: 4, total: 10 });
  });

  it.each([
    ["another contract", { ...built, contractVersion: "hotel-setup-checklist.v2" }],
    ["no property", { ...built, propertyId: "" }],
    ["an unknown phase", { ...built, phase: "paused" }],
    ["more done than there are", { ...built, done: 10 }],
    ["broken setup progress", { ...built, setup: { done: 6, total: 5, next: null } }],
    ["an unknown next screen", { ...built, setup: { done: 1, total: 5, next: "pets" } }],
    ["no items", { ...built, items: null }],
    ["not an object", "checklist"],
  ])("refuses %s", (_case, value) => {
    expect(parseHotelSetupChecklist(value)).toBeNull();
  });
});
