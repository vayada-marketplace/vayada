/**
 * VAY-2247 wave 2, VAY-2451: what both Booking Admin and the PMS dashboards show of setup, from one server
 * answer: the go-live list (`hotel-setup-checklist.v2`). Nothing on it stops bookings. `/status` is untouched.
 * The first checklist (v1, nine items after going live) was removed after the four-step setup went live.
 */

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

const fromDefault = (value: HotelSetupChecklistDefault): HotelSetupChecklistItemState =>
  value === "default" ? "default_in_use" : "done";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * VAY-2451: the four-step setup's dashboard cards, from one server answer.
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
