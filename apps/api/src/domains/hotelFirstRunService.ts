import { FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS } from "@vayada/domain-booking";

import { runFirstRunCalendar, type HotelFirstRunCalendarPorts } from "./hotelFirstRunCalendar.js";
import type { HotelFirstRunSetupProgress } from "./hotelFirstRunFacts.js";
import {
  runFirstRunGuestRules,
  type HotelFirstRunGuestRulesPorts,
} from "./hotelFirstRunGuestRules.js";
import { runFirstRunPlan, type HotelFirstRunPlanPorts } from "./hotelFirstRunPlan.js";
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
  type HotelFirstRunActor,
  type HotelFirstRunSetupPorts,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247: the server's first run, for Booking Admin's four-step setup (VAY-2451). The setup makes its room
 * type itself under the first run's draft id (or skips it) and asks for no price or plan; the first run saves
 * every default the hotel needs to go live: the currency, paying at the property, the placeholder price for
 * the setup's room type, the calendar once there is a room type, the guest rules and the Commission plan. It
 * resumes where it stopped. Steps run in order and stop at the first one that fails, so later steps never run
 * on top of a half-written earlier one. Concurrent runs for the same property are refused.
 *
 * The 7-step setup's request (room types, prices, the taxes tick and a plan) is gone since the four-step
 * setup replaced it; hotels it set up keep what it saved.
 */

export type HotelFirstRunRequest = Readonly<{
  /** Online card comes later (VAY-2205): the first run only sets up paying at the property. */
  guestPayment: "pay_at_property";
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
    facts: {
      read(actor: HotelFirstRunActor): Promise<HotelFirstRunWriteFacts>;
      readSetupProgress(actor: HotelFirstRunActor): Promise<HotelFirstRunSetupProgress>;
    };
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

    /** The light read the setup checklist uses on every dashboard load (VAY-2247 incident). */
    readSetupProgress(actor: HotelFirstRunActor): Promise<HotelFirstRunSetupProgress> {
      return ports.facts.readSetupProgress(actor);
    },

    async run(
      actor: HotelFirstRunActor,
      // Only `{ guestPayment: "pay_at_property" }`: nothing in it changes what the steps do.
      _request: HotelFirstRunRequest,
    ): Promise<HotelFirstRunResult> {
      const result = await ports.lock.withPropertyLock(actor.propertyId, () =>
        runSteps(ports, actor),
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
): Promise<HotelFirstRunResult> {
  const ran: HotelFirstRunStepId[] = [];
  const steps: ReadonlyArray<
    [HotelFirstRunStepId, (facts: HotelFirstRunWriteFacts) => ReturnType<typeof runFirstRunPlan>]
  > = [
    ["currency", (facts) => runFirstRunCurrency(ports, actor, facts.profile?.countryCode ?? null)],
    ["payments", () => runFirstRunPayments(ports, actor)],
    [
      "pricing",
      async (facts) => {
        // The owner's own rooms (no first-run room types) are priced by the owner, not by the first run.
        if (!facts.currency || facts.firstRunRoomTypeIds.length === 0)
          return Object.freeze({ ok: true as const, wrote: false });
        return priceWithPlaceholder(ports, actor, facts);
      },
    ],
    [
      "calendar",
      async (facts) => {
        // A calendar needs a room type (VAY-2451: the room is optional); a later run opens it.
        if (facts.roomTypes.length === 0) return Object.freeze({ ok: true as const, wrote: false });
        return runFirstRunCalendar(ports, actor, {
          propertyProfileRevision: facts.profile?.revision ?? 0,
          timezone: facts.profile?.timezone ?? null,
          roomTypes: facts.roomTypes.map((room) => ({
            roomTypeId: room.roomTypeId,
            expectedRoomFactsRevision: room.roomFactsRevision,
            expectedRoomUnitsRevision: room.roomUnitsRevision,
            activeUnitCount: room.activeUnitCount,
          })),
          inventoryPrepared: facts.calendar.inventoryPrepared,
        });
      },
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
    ["plan", () => runFirstRunPlan(ports, actor)],
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
  });
}

/**
 * VAY-2451: the placeholder price for each room type the setup made under the first run's draft ids, sized
 * to the room type's own occupancy. A room type that has prices already keeps them.
 */
async function priceWithPlaceholder(
  ports: HotelFirstRunPorts,
  actor: HotelFirstRunActor,
  facts: HotelFirstRunWriteFacts,
): Promise<Readonly<{ ok: true; wrote: boolean }> | Readonly<{ ok: false; code: string }>> {
  const occupancies = new Map(
    (await ports.roomRead.listRoomTypeFacts(actor.propertyId)).map((room) => [
      room.roomTypeId,
      room.facts.occupancy,
    ]),
  );
  let wrote = false;
  for (const roomTypeId of facts.firstRunRoomTypeIds) {
    const occupancy = occupancies.get(roomTypeId);
    if (!occupancy || !facts.currency) continue;
    const outcome = await runFirstRunPricing(ports, actor, {
      roomTypeId,
      capacity: {
        total: occupancy.maxGuests,
        adults: occupancy.maxAdults,
        children: occupancy.maxChildren,
      },
      currency: facts.currency.code,
      freeCancellationDays: FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
    });
    if (!outcome.ok) return outcome;
    wrote ||= outcome.wrote;
  }
  return Object.freeze({ ok: true, wrote });
}
