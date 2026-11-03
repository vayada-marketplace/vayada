import { describe, expect, it } from "vitest";

import {
  HOTEL_SETUP_CHECKLIST_ITEMS,
  buildHotelGoLiveChecklist,
  buildHotelSetupChecklist,
  parseHotelGoLiveChecklist,
  parseHotelSetupChecklist,
  type HotelGoLiveChecklistFacts,
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

/** A hotel that finished the four-step setup with its room (VAY-2451 dashboard state B). */
const FINISHED: HotelGoLiveChecklistFacts = {
  propertyId: PROPERTY,
  propertyDetails: true,
  setupFinished: true,
  roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 3, priced: true }],
  placeholderPrices: true,
  bookingRules: "default",
  propertyPhotos: false,
  bookingPublished: false,
  onlineCardReady: false,
  onlineCardsOffered: false,
  viewer: { hidden: false, dismissed: false },
};

const goLiveStates = (facts: HotelGoLiveChecklistFacts) =>
  Object.fromEntries(buildHotelGoLiveChecklist(facts).items.map((item) => [item.id, item.state]));

describe("the go-live checklist (VAY-2451)", () => {
  it("after setup with a room: details and room types done, rates waiting on the placeholder", () => {
    const checklist = buildHotelGoLiveChecklist(FINISHED);
    expect(checklist).toMatchObject({
      contractVersion: "hotel-setup-checklist.v2",
      phase: "go_live",
      setup: { done: 4, total: 4, next: null },
      done: 2,
      total: 6,
      canPublish: false,
      placeholderPrices: true,
      firstRoomType: { name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 3 },
      later: [{ id: "online_cards", state: "later" }],
    });
    expect(goLiveStates(FINISHED)).toEqual({
      property_details: "done",
      room_types: "done",
      rates: "todo",
      booking_rules: "default_in_use",
      property_photos: "todo",
      booking_published: "todo",
    });
  });

  it("offers Publish once room types and real rates are in", () => {
    const real = { ...FINISHED, placeholderPrices: false };
    expect(buildHotelGoLiveChecklist(real)).toMatchObject({ canPublish: true, done: 3 });
    expect(buildHotelGoLiveChecklist(real).roomPhotosMissing).toBe(false);
    // A room type without a photo is enough (publishing needs none); the list suggests one.
    const noPhoto = { ...real, roomTypes: [{ ...real.roomTypes[0]!, photos: 0 }] };
    expect(buildHotelGoLiveChecklist(noPhoto)).toMatchObject({
      canPublish: true,
      done: 3,
      roomPhotosMissing: true,
    });
    expect(goLiveStates(noPhoto).room_types).toBe("done");
    // A room type without rooms isn't; one without prices isn't either.
    const noRooms = { ...real, roomTypes: [{ ...real.roomTypes[0]!, rooms: 0 }] };
    expect(goLiveStates(noRooms).room_types).toBe("todo");
    expect(buildHotelGoLiveChecklist(noRooms)).toMatchObject({
      canPublish: false,
      roomPhotosMissing: false,
    });
    const unpriced = {
      ...real,
      roomTypes: [
        ...real.roomTypes,
        { name: "Suite", rooms: 1, maxGuests: 2, photos: 1, priced: false },
      ],
    };
    expect(goLiveStates(unpriced).rates).toBe("todo");
    expect(buildHotelGoLiveChecklist(unpriced).canPublish).toBe(false);
  });

  it("before Finish setup: step N of 4, the room next until it can be sold", () => {
    const started = { ...FINISHED, setupFinished: false, roomTypes: [], placeholderPrices: false };
    expect(buildHotelGoLiveChecklist(started)).toMatchObject({
      phase: "setup",
      setup: { done: 2, total: 4, next: "room" },
      firstRoomType: null,
    });
    const withRoom = { ...FINISHED, setupFinished: false };
    expect(buildHotelGoLiveChecklist(withRoom).setup).toEqual({
      done: 3,
      total: 4,
      next: "payments",
    });
  });

  it("is live once published, with rules reviewed and photos added counting as done", () => {
    const live = {
      ...FINISHED,
      placeholderPrices: false,
      bookingRules: "acknowledged" as const,
      propertyPhotos: true,
      bookingPublished: true,
      onlineCardsOffered: true,
    };
    expect(buildHotelGoLiveChecklist(live)).toMatchObject({
      phase: "live",
      done: 6,
      total: 6,
      later: [{ id: "online_cards", state: "todo" }],
    });
  });

  it("round-trips through the parser and tolerates what a newer server adds", () => {
    const checklist = buildHotelGoLiveChecklist(FINISHED);
    expect(parseHotelGoLiveChecklist(JSON.parse(JSON.stringify(checklist)))).toEqual(checklist);
    const newer = {
      ...JSON.parse(JSON.stringify(checklist)),
      items: [...checklist.items, { id: "channel_manager", state: "todo" }],
      later: [...checklist.later, { id: "something_new", state: "later" }],
    };
    expect(parseHotelGoLiveChecklist(newer)).toEqual(checklist);
    // The photo hint, and an older server's answer without it (no hint).
    const noPhoto = buildHotelGoLiveChecklist({
      ...FINISHED,
      roomTypes: [{ ...FINISHED.roomTypes[0]!, photos: 0 }],
    });
    expect(parseHotelGoLiveChecklist(JSON.parse(JSON.stringify(noPhoto)))).toEqual(noPhoto);
    const { roomPhotosMissing: _hint, ...older } = JSON.parse(JSON.stringify(noPhoto));
    expect(parseHotelGoLiveChecklist(older)?.roomPhotosMissing).toBe(false);
    expect(
      parseHotelGoLiveChecklist({ ...checklist, contractVersion: "hotel-setup-checklist.v1" }),
    ).toBeNull();
    expect(parseHotelGoLiveChecklist({ ...checklist, phase: "complete" })).toBeNull();
    expect(
      parseHotelGoLiveChecklist({ ...checklist, setup: { done: 5, total: 4, next: null } }),
    ).toBeNull();
  });
});
