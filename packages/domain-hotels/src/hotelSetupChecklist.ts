/**
 * VAY-2247 wave 2: the setup checklist both Booking Admin and the PMS show on their dashboards, from one
 * server answer. Before the booking page is published it follows the five setup screens; after, nine items,
 * the first four of them done by setup itself. Nothing on it stops bookings. `/status` is untouched.
 */

export const HOTEL_SETUP_CHECKLIST_CONTRACT_VERSION = "hotel-setup-checklist.v1";

/** The setup screens, in order (the first run in Booking Admin). */
export const HOTEL_SETUP_CHECKLIST_SETUP_STEPS = [
  "about_you",
  "hotel",
  "first_room",
  "guest_payment",
  "go_live",
] as const;
export type HotelSetupChecklistSetupStep = (typeof HOTEL_SETUP_CHECKLIST_SETUP_STEPS)[number];

/** The checklist after going live, in the order it shows them. */
export const HOTEL_SETUP_CHECKLIST_ITEMS = [
  "hotel_basics",
  "first_room",
  "guest_payment",
  "booking_published",
  "photos",
  "style",
  "calendar",
  "guest_terms",
  "online_cards",
] as const;
export type HotelSetupChecklistItemId = (typeof HOTEL_SETUP_CHECKLIST_ITEMS)[number];

/**
 * done · todo (nothing yet) · default_in_use (setup's default works; "Looks good" or a change makes it done)
 * · later (not offered yet, e.g. online cards before VAY-2205 goes live).
 */
export const HOTEL_SETUP_CHECKLIST_ITEM_STATES = [
  "done",
  "todo",
  "default_in_use",
  "later",
] as const;
export type HotelSetupChecklistItemState = (typeof HOTEL_SETUP_CHECKLIST_ITEM_STATES)[number];

/** Items the owner can accept as they are ("Looks good"), per hotel. */
export const HOTEL_SETUP_CHECKLIST_ACKNOWLEDGEABLE = ["calendar", "guest_terms"] as const;
export type HotelSetupChecklistAcknowledgeable =
  (typeof HOTEL_SETUP_CHECKLIST_ACKNOWLEDGEABLE)[number];

/** A setting setup chose a default for: still the default, accepted with "Looks good", or changed. */
export type HotelSetupChecklistDefault = "default" | "acknowledged" | "changed";

export type HotelSetupChecklistFacts = Readonly<{
  propertyId: string;
  /** The first setup screen not done yet; null once all five are (the page is published). */
  nextSetupStep: HotelSetupChecklistSetupStep | null;
  hotelBasics: boolean;
  /** Room types with rooms and saved prices. */
  firstRoom: boolean;
  /** How guests pay and the vayada plan. */
  guestPayment: boolean;
  bookingPublished: boolean;
  /** At least one approved hotel or room photo. */
  photos: boolean;
  /** A logo, or a page style the owner chose instead of setup's. */
  style: boolean;
  calendar: HotelSetupChecklistDefault;
  guestTerms: HotelSetupChecklistDefault;
  /** Online card payments can be offered (Stripe connected and ready). */
  onlineCardReady: boolean;
  /** Online card payments are offered to hotels at all (VAY-2205); until then the item says Later. */
  onlineCardsOffered: boolean;
  /** The signed-in person's own view: "Hide for now", and "Dismiss" once everything is done. */
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

export type HotelSetupChecklistItem = Readonly<{
  id: HotelSetupChecklistItemId;
  state: HotelSetupChecklistItemState;
}>;

export type HotelSetupChecklist = Readonly<{
  contractVersion: typeof HOTEL_SETUP_CHECKLIST_CONTRACT_VERSION;
  propertyId: string;
  /** setup: the page isn't live yet · live: the checklist · complete: everything is done. */
  phase: "setup" | "live" | "complete";
  /** Before going live: how far setup is (step N of 5) and which screen is next. */
  setup: Readonly<{
    done: number;
    total: number;
    next: HotelSetupChecklistSetupStep | null;
  }>;
  items: readonly HotelSetupChecklistItem[];
  done: number;
  total: number;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

const fromDefault = (value: HotelSetupChecklistDefault): HotelSetupChecklistItemState =>
  value === "default" ? "default_in_use" : "done";

export function buildHotelSetupChecklist(facts: HotelSetupChecklistFacts): HotelSetupChecklist {
  const states: Record<HotelSetupChecklistItemId, HotelSetupChecklistItemState> = {
    hotel_basics: facts.hotelBasics ? "done" : "todo",
    first_room: facts.firstRoom ? "done" : "todo",
    guest_payment: facts.guestPayment ? "done" : "todo",
    booking_published: facts.bookingPublished ? "done" : "todo",
    photos: facts.photos ? "done" : "todo",
    style: facts.style ? "done" : "default_in_use",
    calendar: fromDefault(facts.calendar),
    guest_terms: fromDefault(facts.guestTerms),
    online_cards: facts.onlineCardReady ? "done" : facts.onlineCardsOffered ? "todo" : "later",
  };
  const items = HOTEL_SETUP_CHECKLIST_ITEMS.map((id) => Object.freeze({ id, state: states[id] }));
  const done = items.filter((item) => item.state === "done").length;
  const next = facts.bookingPublished ? null : (facts.nextSetupStep ?? "go_live");
  return Object.freeze({
    contractVersion: HOTEL_SETUP_CHECKLIST_CONTRACT_VERSION,
    propertyId: facts.propertyId,
    phase: !facts.bookingPublished ? "setup" : done === items.length ? "complete" : "live",
    setup: Object.freeze({
      done:
        next === null
          ? HOTEL_SETUP_CHECKLIST_SETUP_STEPS.length
          : HOTEL_SETUP_CHECKLIST_SETUP_STEPS.indexOf(next),
      total: HOTEL_SETUP_CHECKLIST_SETUP_STEPS.length,
      next,
    }),
    items: Object.freeze(items),
    done,
    total: items.length,
    viewer: Object.freeze({ hidden: facts.viewer.hidden, dismissed: facts.viewer.dismissed }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Reads the server's checklist, tolerating a newer one: unknown items and states are left out (the counts
 * stay the server's), so an older dashboard keeps working when the checklist grows. Null when it can't be
 * read at all, which the dashboards treat as "no checklist".
 */
export function parseHotelSetupChecklist(value: unknown): HotelSetupChecklist | null {
  if (!isRecord(value) || value.contractVersion !== HOTEL_SETUP_CHECKLIST_CONTRACT_VERSION)
    return null;
  if (typeof value.propertyId !== "string" || !value.propertyId) return null;
  if (!oneOf(["setup", "live", "complete"] as const, value.phase)) return null;
  const setup = isRecord(value.setup) ? value.setup : null;
  const setupDone = count(setup?.done);
  const setupTotal = count(setup?.total);
  if (setupDone === null || setupTotal === null || setupDone > setupTotal) return null;
  const next = setup?.next ?? null;
  if (next !== null && !oneOf(HOTEL_SETUP_CHECKLIST_SETUP_STEPS, next)) return null;
  if (!Array.isArray(value.items)) return null;
  const items = value.items.flatMap((item) =>
    isRecord(item) &&
    oneOf(HOTEL_SETUP_CHECKLIST_ITEMS, item.id) &&
    oneOf(HOTEL_SETUP_CHECKLIST_ITEM_STATES, item.state)
      ? [Object.freeze({ id: item.id, state: item.state })]
      : [],
  );
  const done = count(value.done);
  const total = count(value.total);
  if (done === null || total === null || done > total) return null;
  const viewer = isRecord(value.viewer) ? value.viewer : null;
  return Object.freeze({
    contractVersion: HOTEL_SETUP_CHECKLIST_CONTRACT_VERSION,
    propertyId: value.propertyId,
    phase: value.phase,
    setup: Object.freeze({ done: setupDone, total: setupTotal, next }),
    items: Object.freeze(items),
    done,
    total,
    viewer: Object.freeze({
      hidden: viewer?.hidden === true,
      dismissed: viewer?.dismissed === true,
    }),
  });
}

/**
 * VAY-2451: the four-step setup's dashboard cards, from one server answer (served next to v1, which the
 * current dashboards keep reading until the new setup is switched on).
 * - setup: setup isn't finished: "Finish setting up", step N of 4 and the next one;
 * - go_live: setup is finished, the page isn't live: the go-live list, Publish once rooms and rates are in;
 * - live: the page is published.
 */
export const HOTEL_GO_LIVE_CHECKLIST_CONTRACT_VERSION = "hotel-setup-checklist.v2";

/** The four setup steps, in order. */
export const HOTEL_GO_LIVE_SETUP_STEPS = ["property", "location", "room", "payments"] as const;
export type HotelGoLiveSetupStep = (typeof HOTEL_GO_LIVE_SETUP_STEPS)[number];

/** The go-live list, in the order it shows them; the last one is publishing the page. */
export const HOTEL_GO_LIVE_ITEMS = [
  "property_details",
  "room_types",
  "rates",
  "booking_rules",
  "property_photos",
  "booking_published",
] as const;
export type HotelGoLiveItemId = (typeof HOTEL_GO_LIVE_ITEMS)[number];

/** Optional extras under "Later, when you're ready". */
export const HOTEL_GO_LIVE_LATER_ITEMS = ["online_cards"] as const;
export type HotelGoLiveLaterItemId = (typeof HOTEL_GO_LIVE_LATER_ITEMS)[number];

/** One active room type, as the go-live list describes it. */
export type HotelGoLiveRoomType = Readonly<{
  name: string;
  /** Rooms of this type (active units). */
  rooms: number;
  maxGuests: number;
  photos: number;
  /** It has saved prices (the placeholder counts; see `placeholderPrices`). */
  priced: boolean;
}>;

export type HotelGoLiveChecklistFacts = Readonly<{
  propertyId: string;
  /** The hotel's profile is complete (it always is once setup created the hotel). */
  propertyDetails: boolean;
  /** Finish setup ran: how guests pay and the vayada plan are saved. */
  setupFinished: boolean;
  /** Active room types, in display order. */
  roomTypes: readonly HotelGoLiveRoomType[];
  /** The current prices are the first run's placeholder (VAY-2451). */
  placeholderPrices: boolean;
  bookingRules: HotelSetupChecklistDefault;
  /** At least one approved hotel photo (not a room photo). */
  propertyPhotos: boolean;
  bookingPublished: boolean;
  onlineCardReady: boolean;
  onlineCardsOffered: boolean;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

export type HotelGoLiveChecklist = Readonly<{
  contractVersion: typeof HOTEL_GO_LIVE_CHECKLIST_CONTRACT_VERSION;
  propertyId: string;
  phase: "setup" | "go_live" | "live";
  setup: Readonly<{ done: number; total: number; next: HotelGoLiveSetupStep | null }>;
  items: readonly Readonly<{ id: HotelGoLiveItemId; state: HotelSetupChecklistItemState }>[];
  later: readonly Readonly<{ id: HotelGoLiveLaterItemId; state: HotelSetupChecklistItemState }>[];
  done: number;
  total: number;
  /** Publish is offered once room types and real rates are in; readiness still has the last word. */
  canPublish: boolean;
  /**
   * A room type with rooms has no photo yet: the room types row stays done (publishing needs none) and
   * suggests adding one.
   */
  roomPhotosMissing: boolean;
  /** The first room type, for "Deluxe Double · 2 rooms · up to 2 guests · 3 photos"; null without one. */
  firstRoomType: HotelGoLiveRoomType | null;
  placeholderPrices: boolean;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

/** A room type the page can sell: it has rooms. A photo isn't needed to publish, only suggested. */
const sellable = (room: HotelGoLiveRoomType) => room.rooms > 0;

export function buildHotelGoLiveChecklist(facts: HotelGoLiveChecklistFacts): HotelGoLiveChecklist {
  const roomTypesDone = facts.roomTypes.some(sellable);
  const ratesDone =
    facts.roomTypes.length > 0 &&
    facts.roomTypes.every((room) => room.priced) &&
    !facts.placeholderPrices;
  const states: Record<HotelGoLiveItemId, HotelSetupChecklistItemState> = {
    property_details: facts.propertyDetails ? "done" : "todo",
    room_types: roomTypesDone ? "done" : "todo",
    rates: ratesDone ? "done" : "todo",
    booking_rules: fromDefault(facts.bookingRules),
    property_photos: facts.propertyPhotos ? "done" : "todo",
    booking_published: facts.bookingPublished ? "done" : "todo",
  };
  const items = HOTEL_GO_LIVE_ITEMS.map((id) => Object.freeze({ id, state: states[id] }));
  // Steps 1 and 2 are done once the hotel exists; the room counts once it can be sold.
  const stepsDone = { property: true, location: true, room: roomTypesDone, payments: false };
  const next = facts.setupFinished
    ? null
    : (HOTEL_GO_LIVE_SETUP_STEPS.find((step) => !stepsDone[step]) ?? "payments");
  const first = facts.roomTypes[0];
  return Object.freeze({
    contractVersion: HOTEL_GO_LIVE_CHECKLIST_CONTRACT_VERSION,
    propertyId: facts.propertyId,
    phase: facts.bookingPublished ? "live" : facts.setupFinished ? "go_live" : "setup",
    setup: Object.freeze({
      done:
        next === null ? HOTEL_GO_LIVE_SETUP_STEPS.length : HOTEL_GO_LIVE_SETUP_STEPS.indexOf(next),
      total: HOTEL_GO_LIVE_SETUP_STEPS.length,
      next,
    }),
    items: Object.freeze(items),
    later: Object.freeze([
      Object.freeze({
        id: "online_cards" as const,
        state: facts.onlineCardReady ? "done" : facts.onlineCardsOffered ? "todo" : "later",
      }),
    ]),
    done: items.filter((item) => item.state === "done").length,
    total: items.length,
    canPublish: roomTypesDone && ratesDone,
    roomPhotosMissing: facts.roomTypes.some((room) => sellable(room) && room.photos === 0),
    firstRoomType: first ? Object.freeze({ ...first }) : null,
    placeholderPrices: facts.placeholderPrices,
    viewer: Object.freeze({ hidden: facts.viewer.hidden, dismissed: facts.viewer.dismissed }),
  });
}

/**
 * Reads the server's go-live list, tolerating a newer one (unknown items and states are left out). Null
 * when it can't be read at all, which the dashboards treat as "no checklist".
 */
export function parseHotelGoLiveChecklist(value: unknown): HotelGoLiveChecklist | null {
  if (!isRecord(value) || value.contractVersion !== HOTEL_GO_LIVE_CHECKLIST_CONTRACT_VERSION)
    return null;
  if (typeof value.propertyId !== "string" || !value.propertyId) return null;
  if (!oneOf(["setup", "go_live", "live"] as const, value.phase)) return null;
  const setup = isRecord(value.setup) ? value.setup : null;
  const setupDone = count(setup?.done);
  const setupTotal = count(setup?.total);
  if (setupDone === null || setupTotal === null || setupDone > setupTotal) return null;
  const next = setup?.next ?? null;
  if (next !== null && !oneOf(HOTEL_GO_LIVE_SETUP_STEPS, next)) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.later)) return null;
  const items = value.items.flatMap((item) =>
    isRecord(item) &&
    oneOf(HOTEL_GO_LIVE_ITEMS, item.id) &&
    oneOf(HOTEL_SETUP_CHECKLIST_ITEM_STATES, item.state)
      ? [Object.freeze({ id: item.id, state: item.state })]
      : [],
  );
  const later = value.later.flatMap((item) =>
    isRecord(item) &&
    oneOf(HOTEL_GO_LIVE_LATER_ITEMS, item.id) &&
    oneOf(HOTEL_SETUP_CHECKLIST_ITEM_STATES, item.state)
      ? [Object.freeze({ id: item.id, state: item.state })]
      : [],
  );
  const done = count(value.done);
  const total = count(value.total);
  if (done === null || total === null || done > total) return null;
  const room = isRecord(value.firstRoomType) ? value.firstRoomType : null;
  const firstRoomType =
    room &&
    typeof room.name === "string" &&
    count(room.rooms) !== null &&
    count(room.maxGuests) !== null &&
    count(room.photos) !== null
      ? Object.freeze({
          name: room.name,
          rooms: room.rooms as number,
          maxGuests: room.maxGuests as number,
          photos: room.photos as number,
          priced: room.priced === true,
        })
      : null;
  const viewer = isRecord(value.viewer) ? value.viewer : null;
  return Object.freeze({
    contractVersion: HOTEL_GO_LIVE_CHECKLIST_CONTRACT_VERSION,
    propertyId: value.propertyId,
    phase: value.phase,
    setup: Object.freeze({ done: setupDone, total: setupTotal, next }),
    items: Object.freeze(items),
    later: Object.freeze(later),
    done,
    total,
    canPublish: value.canPublish === true,
    // Older servers don't send it: no hint.
    roomPhotosMissing: value.roomPhotosMissing === true,
    firstRoomType,
    placeholderPrices: value.placeholderPrices === true,
    viewer: Object.freeze({
      hidden: viewer?.hidden === true,
      dismissed: viewer?.dismissed === true,
    }),
  });
}
