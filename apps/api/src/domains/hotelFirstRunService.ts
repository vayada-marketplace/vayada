import { firstRunRoomFacts, type FirstRunRoomInput } from "@vayada/domain-booking";

import { runFirstRunCalendar, type HotelFirstRunCalendarPorts } from "./hotelFirstRunCalendar.js";
import {
  runFirstRunGuestRules,
  type HotelFirstRunGuestRulesPorts,
} from "./hotelFirstRunGuestRules.js";
import {
  runFirstRunPlan,
  type HotelFirstRunPlanChoice,
  type HotelFirstRunPlanPorts,
} from "./hotelFirstRunPlan.js";
import { runFirstRunPricing, type HotelFirstRunPricingPorts } from "./hotelFirstRunPricing.js";
import {
  hotelFirstRunState,
  type HotelFirstRunFacts,
  type HotelFirstRunState,
  type HotelFirstRunStepId,
} from "./hotelFirstRunState.js";
import {
  runFirstRunCurrency,
  runFirstRunPayments,
  runFirstRunRooms,
  FIRST_RUN_MAX_ROOM_TYPES,
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247: the server's first run. It takes what the new setup collects (the room types and their prices,
 * the taxes tick, how guests pay and the plan), saves every default the hotel needs to go live, and resumes
 * where it stopped. Steps run in order and stop at the first one that fails, so later steps never run on
 * top of a half-written earlier one. Concurrent runs for the same property are refused.
 */

export type HotelFirstRunRequest = Readonly<{
  /** The room types to create, in order: 1 to FIRST_RUN_MAX_ROOM_TYPES, with different names. */
  rooms: readonly FirstRunRoomInput[];
  pricesIncludeMandatoryCharges: boolean;
  /** Online card comes later (VAY-2205): the first run only sets up paying at the property. */
  guestPayment: "pay_at_property";
  plan: HotelFirstRunPlanChoice;
}>;

/** The state facts plus what the steps need to write: the first run's room types and the hotel's language. */
export type HotelFirstRunWriteFacts = HotelFirstRunFacts &
  Readonly<{ firstRunRoomTypeIds: readonly string[]; language: string | null }>;

export type HotelFirstRunPorts = HotelFirstRunSetupPorts &
  HotelFirstRunPricingPorts &
  HotelFirstRunCalendarPorts &
  HotelFirstRunGuestRulesPorts &
  HotelFirstRunPlanPorts &
  Readonly<{
    facts: { read(actor: HotelFirstRunActor): Promise<HotelFirstRunWriteFacts> };
    /** Runs `work` while holding the property's first-run lock, or returns "busy" when another run holds it. */
    lock: { withPropertyLock<T>(propertyId: string, work: () => Promise<T>): Promise<T | "busy"> };
    /** Makes the hotel live once its profile is complete (VAY-2247 1.5); a live hotel stays live. */
    activation: {
      activateWhenComplete(
        actor: HotelFirstRunActor,
      ): Promise<Readonly<{ ok: true; activated: boolean } | { ok: false; code: string }>>;
    };
  }>;

export type HotelFirstRunResult =
  | Readonly<{
      ok: true;
      state: HotelFirstRunState;
      ran: readonly HotelFirstRunStepId[];
      checkoutUrl: string | null;
    }>
  | Readonly<{
      ok: false;
      code: string;
      step: HotelFirstRunStepId | null;
      state: HotelFirstRunState | null;
      ran: readonly HotelFirstRunStepId[];
    }>;

export function createHotelFirstRunService(ports: HotelFirstRunPorts) {
  return {
    async read(actor: HotelFirstRunActor): Promise<HotelFirstRunState> {
      return hotelFirstRunState(await ports.facts.read(actor));
    },

    async run(
      actor: HotelFirstRunActor,
      request: HotelFirstRunRequest,
      customerEmail: string | null,
    ): Promise<HotelFirstRunResult> {
      const result = await ports.lock.withPropertyLock(actor.propertyId, () =>
        runSteps(ports, actor, request, customerEmail),
      );
      return result === "busy"
        ? Object.freeze({
            ok: false,
            code: "first_run_in_progress",
            step: null,
            state: null,
            ran: [],
          })
        : result;
    },
  };
}

async function runSteps(
  ports: HotelFirstRunPorts,
  actor: HotelFirstRunActor,
  request: HotelFirstRunRequest,
  customerEmail: string | null,
): Promise<HotelFirstRunResult> {
  const ran: HotelFirstRunStepId[] = [];
  let checkoutUrl: string | null = null;
  const occupancies = request.rooms.map((room) => firstRunRoomFacts(room)?.occupancy ?? null);
  const names = new Set(request.rooms.map((room) => room.name.trim().toLowerCase()));
  if (
    request.rooms.length < 1 ||
    request.rooms.length > FIRST_RUN_MAX_ROOM_TYPES ||
    names.size !== request.rooms.length ||
    occupancies.some((occupancy) => !occupancy)
  ) {
    return Object.freeze({
      ok: false,
      code: "first_run_room_invalid",
      step: "rooms",
      state: null,
      ran,
    });
  }

  const steps: ReadonlyArray<
    [HotelFirstRunStepId, (facts: HotelFirstRunWriteFacts) => ReturnType<typeof runFirstRunPlan>]
  > = [
    ["currency", (facts) => runFirstRunCurrency(ports, actor, facts.profile?.countryCode ?? null)],
    ["rooms", () => runFirstRunRooms(ports, actor, request.rooms)],
    ["payments", () => runFirstRunPayments(ports, actor)],
    [
      "pricing",
      async (facts) => {
        // The owner's own rooms (no first-run room types) are priced by the owner, not by the first run.
        if (!facts.currency || facts.firstRunRoomTypeIds.length === 0)
          return Object.freeze({ ok: true as const, wrote: false });
        let wrote = false;
        for (const [index, roomTypeId] of facts.firstRunRoomTypeIds.entries()) {
          const room = request.rooms[index];
          const occupancy = occupancies[index];
          if (!room || !occupancy) break;
          const outcome = await runFirstRunPricing(ports, actor, {
            roomTypeId,
            capacity: {
              total: occupancy.maxGuests,
              adults: occupancy.maxAdults,
              children: occupancy.maxChildren,
            },
            currency: facts.currency.code,
            pricePerNight: room.pricePerNight,
            pricesIncludeMandatoryCharges: request.pricesIncludeMandatoryCharges,
          });
          if (!outcome.ok) return outcome;
          wrote ||= outcome.wrote;
        }
        return Object.freeze({ ok: true as const, wrote });
      },
    ],
    [
      "calendar",
      (facts) =>
        runFirstRunCalendar(ports, actor, {
          propertyProfileRevision: facts.profile?.revision ?? 0,
          timezone: facts.profile?.timezone ?? null,
          roomTypes: facts.roomTypes.map((room) => ({
            roomTypeId: room.roomTypeId,
            expectedRoomFactsRevision: room.roomFactsRevision,
            expectedRoomUnitsRevision: room.roomUnitsRevision,
            activeUnitCount: room.activeUnitCount,
          })),
          inventoryPrepared: facts.calendar.inventoryPrepared,
        }),
    ],
    [
      "guest_rules",
      (facts) =>
        runFirstRunGuestRules(ports, actor, {
          language: facts.language,
          hasCity: Boolean(facts.profile?.city),
          localityPublic: facts.profile?.localityPublic ?? false,
        }),
    ],
    ["plan", () => runFirstRunPlan(ports, actor, { plan: request.plan, customerEmail })],
  ];

  for (const [step, run] of steps) {
    const facts = await ports.facts.read(actor);
    const outcome = await run(facts);
    if (!outcome.ok) {
      return Object.freeze({
        ok: false,
        code: outcome.code,
        step,
        state: hotelFirstRunState(await ports.facts.read(actor)),
        ran,
      });
    }
    if (outcome.wrote) ran.push(step);
    if ("checkoutUrl" in outcome) checkoutUrl = outcome.checkoutUrl;
  }
  // VAY-2247 1.5: everything is saved, so the hotel goes live (its profile is complete with its basics);
  // a later run finds it live already. Publishing still waits for the owner on Go live.
  const activation = await ports.activation.activateWhenComplete(actor);
  if (!activation.ok) {
    return Object.freeze({
      ok: false,
      code: activation.code,
      step: null,
      state: hotelFirstRunState(await ports.facts.read(actor)),
      ran,
    });
  }
  return Object.freeze({
    ok: true,
    state: hotelFirstRunState(await ports.facts.read(actor)),
    ran,
    checkoutUrl,
  });
}
