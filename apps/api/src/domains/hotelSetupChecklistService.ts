import {
  buildHotelSetupChecklist,
  type HotelSetupChecklist,
  type HotelSetupChecklistAcknowledgeable,
  type HotelSetupChecklistDefault,
} from "@vayada/domain-hotels";

import type { HotelFirstRunState } from "./hotelFirstRunState.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 wave 2: the setup checklist both dashboards show. Setup progress comes from the first run's own
 * state; the rest from what the hotel has, read in one query, plus the two things the checklist remembers
 * (migration 0501): "Looks good" per hotel and each person's Hide for now / Dismiss.
 */

/** What one query tells about the hotel and the signed-in person; null when the hotel isn't there. */
export type HotelSetupChecklistFactsRow = Readonly<{
  hotelBasics: boolean;
  bookingPublished: boolean;
  photos: boolean;
  style: boolean;
  calendar: HotelSetupChecklistDefault;
  guestTerms: HotelSetupChecklistDefault;
  onlineCardReady: boolean;
  viewer: Readonly<{ hidden: boolean; dismissed: boolean }>;
}>;

export type HotelSetupChecklistViewerChange = Readonly<{ hidden?: boolean; dismissed?: boolean }>;

export type HotelSetupChecklistPorts = Readonly<{
  firstRun: { read(actor: HotelFirstRunActor): Promise<HotelFirstRunState> };
  facts: { read(actor: HotelFirstRunActor): Promise<HotelSetupChecklistFactsRow | null> };
  store: {
    acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable): Promise<void>;
    setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange): Promise<void>;
  };
  /** Online card payments are offered to hotels (VAY-2205); until then the item says Later. */
  onlineCardsOffered: boolean;
}>;

export function createHotelSetupChecklistService(ports: HotelSetupChecklistPorts) {
  async function read(actor: HotelFirstRunActor): Promise<HotelSetupChecklist | null> {
    const [state, facts] = await Promise.all([ports.firstRun.read(actor), ports.facts.read(actor)]);
    if (!facts) return null;
    const done = (id: HotelFirstRunState["steps"][number]["id"]) =>
      state.steps.find((step) => step.id === id)?.state === "done";
    const firstRoom = done("rooms") && done("pricing");
    const guestPayment = done("payments") && done("plan");
    return buildHotelSetupChecklist({
      propertyId: actor.propertyId,
      nextSetupStep: !firstRoom ? "first_room" : !guestPayment ? "guest_payment" : "go_live",
      hotelBasics: facts.hotelBasics,
      firstRoom,
      guestPayment,
      bookingPublished: facts.bookingPublished,
      photos: facts.photos,
      style: facts.style,
      calendar: facts.calendar,
      guestTerms: facts.guestTerms,
      onlineCardReady: facts.onlineCardReady,
      onlineCardsOffered: ports.onlineCardsOffered,
      viewer: facts.viewer,
    });
  }

  return {
    read,
    /** "Looks good": the hotel keeps setup's default for the item; returns the checklist after it. */
    async acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable) {
      await ports.store.acknowledge(actor, item);
      return read(actor);
    },
    /** The signed-in person's Hide for now (or showing it again) and Dismiss. */
    async setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange) {
      await ports.store.setViewer(actor, change);
      return read(actor);
    },
  };
}

export type HotelSetupChecklistService = ReturnType<typeof createHotelSetupChecklistService>;
