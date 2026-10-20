import { FIRST_RUN_DEFAULTS_VERSION } from "@vayada/domain-booking";

/**
 * VAY-2247 first run: where a new hotel stands, step by step. The steps run in this order because each one
 * needs the one before (pricing needs payments in place, the calendar is pinned to the room revisions):
 * currency → rooms → payments → pricing → calendar → guest rules → plan.
 *
 * Nothing is stored for the first run itself. Each step's state is derived from the hotel's real data
 * (the facts below, read by the adapters), so a resume after any interruption picks up where it stopped and
 * never redoes or overwrites what the owner already set.
 */
export const HOTEL_FIRST_RUN_CONTRACT_VERSION = "hotel-first-run.v1" as const;

export const HOTEL_FIRST_RUN_STEPS = Object.freeze([
  "currency",
  "rooms",
  "payments",
  "pricing",
  "calendar",
  "guest_rules",
  "plan",
] as const);
export type HotelFirstRunStepId = (typeof HOTEL_FIRST_RUN_STEPS)[number];

/** done · stale (saved, but something it depends on changed since) · todo · blocked (an input is missing) ·
 * awaiting_checkout (Fixed Fee: Stripe checkout started, the plan activates when Stripe confirms). */
export type HotelFirstRunStepState = "done" | "stale" | "todo" | "blocked" | "awaiting_checkout";

export type HotelFirstRunBlocker =
  | "property_timezone_missing"
  | "property_profile_missing"
  | "room_units_unlabelled"
  | "pricing_rooms_changed"
  | "pricing_payments_changed"
  | "pricing_terms_changed"
  | "payment_currency_changed"
  | "operating_calendar_stale"
  | "inventory_not_prepared";

export type HotelFirstRunRoomTypeFacts = Readonly<{
  roomTypeId: string;
  roomFactsRevision: number;
  roomUnitsRevision: number;
  activeUnitCount: number;
  /** Active units without a verified label; auto-open stays off until every unit has one. */
  unlabelledUnitIds: readonly string[];
}>;

/** A snapshot of the hotel's real data, read in one go by the adapters. */
export type HotelFirstRunFacts = Readonly<{
  propertyId: string;
  profile: Readonly<{
    revision: number;
    countryCode: string | null;
    timezone: string | null;
    city: string | null;
    localityPublic: boolean;
  }> | null;
  currency: Readonly<{ code: string; revision: number }> | null;
  roomTypes: readonly HotelFirstRunRoomTypeFacts[];
  payments: Readonly<{ payAtPropertySelected: boolean; currencyMatches: boolean }>;
  pricing: Readonly<{
    pricedRoomTypeIds: readonly string[];
    staleReasons: readonly (
      | "pricing_rooms_changed"
      | "pricing_payments_changed"
      | "pricing_terms_changed"
    )[];
  }>;
  calendar: Readonly<{ configured: boolean; stale: boolean; inventoryPrepared: boolean }>;
  guestRules: Readonly<{ rulesSaved: boolean; termsSaved: boolean; designSaved: boolean }>;
  plan: "none" | "commission" | "fixed" | "fixed_checkout_pending";
}>;

export type HotelFirstRunStep = Readonly<{
  id: HotelFirstRunStepId;
  state: HotelFirstRunStepState;
  blockers: readonly HotelFirstRunBlocker[];
}>;

export type HotelFirstRunState = Readonly<{
  contractVersion: typeof HOTEL_FIRST_RUN_CONTRACT_VERSION;
  defaultsVersion: typeof FIRST_RUN_DEFAULTS_VERSION;
  propertyId: string;
  steps: readonly HotelFirstRunStep[];
  /** The first step that still needs a write, or null when every step is done or waiting on Stripe. */
  nextStep: HotelFirstRunStepId | null;
}>;

function step(
  id: HotelFirstRunStepId,
  state: HotelFirstRunStepState,
  blockers: HotelFirstRunBlocker[] = [],
) {
  return Object.freeze({ id, state, blockers: Object.freeze(blockers) });
}

function roomsStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  if (facts.roomTypes.length === 0) return step("rooms", "todo");
  const incomplete = facts.roomTypes.some((room) => room.activeUnitCount < 1);
  const unlabelled = facts.roomTypes.some((room) => room.unlabelledUnitIds.length > 0);
  if (incomplete) return step("rooms", "todo");
  return unlabelled ? step("rooms", "todo", ["room_units_unlabelled"]) : step("rooms", "done");
}

function paymentsStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  if (!facts.payments.payAtPropertySelected) return step("payments", "todo");
  return facts.payments.currencyMatches
    ? step("payments", "done")
    : step("payments", "stale", ["payment_currency_changed"]);
}

function pricingStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  if (facts.pricing.staleReasons.length > 0)
    return step("pricing", "stale", [...facts.pricing.staleReasons]);
  const priced = new Set(facts.pricing.pricedRoomTypeIds);
  const allPriced =
    facts.roomTypes.length > 0 && facts.roomTypes.every((room) => priced.has(room.roomTypeId));
  return step("pricing", allPriced ? "done" : "todo");
}

function calendarStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  if (!facts.profile) return step("calendar", "blocked", ["property_profile_missing"]);
  if (!facts.profile.timezone) return step("calendar", "blocked", ["property_timezone_missing"]);
  if (facts.calendar.stale) return step("calendar", "stale", ["operating_calendar_stale"]);
  if (!facts.calendar.configured) return step("calendar", "todo");
  return facts.calendar.inventoryPrepared
    ? step("calendar", "done")
    : step("calendar", "todo", ["inventory_not_prepared"]);
}

function guestRulesStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  const { rulesSaved, termsSaved, designSaved } = facts.guestRules;
  // "Show city and country" only applies once the hotel has a city to show.
  const localityDone = !facts.profile?.city || facts.profile.localityPublic;
  return step(
    "guest_rules",
    rulesSaved && termsSaved && designSaved && localityDone ? "done" : "todo",
  );
}

function planStep(facts: HotelFirstRunFacts): HotelFirstRunStep {
  if (facts.plan === "fixed_checkout_pending") return step("plan", "awaiting_checkout");
  return step("plan", facts.plan === "none" ? "todo" : "done");
}

export function hotelFirstRunState(facts: HotelFirstRunFacts): HotelFirstRunState {
  const steps = [
    step("currency", facts.currency ? "done" : "todo"),
    roomsStep(facts),
    paymentsStep(facts),
    pricingStep(facts),
    calendarStep(facts),
    guestRulesStep(facts),
    planStep(facts),
  ];
  const next = steps.find(
    (current) =>
      current.state === "todo" || current.state === "stale" || current.state === "blocked",
  );
  return Object.freeze({
    contractVersion: HOTEL_FIRST_RUN_CONTRACT_VERSION,
    defaultsVersion: FIRST_RUN_DEFAULTS_VERSION,
    propertyId: facts.propertyId,
    steps: Object.freeze(steps),
    nextStep: next?.id ?? null,
  });
}
