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
